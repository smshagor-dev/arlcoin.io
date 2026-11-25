// Experimental host-side Docker resource metering for cgroup v2 + cgroupfs.
// A fresh, persistent cgroup parent retains hierarchical CPU/memory counters after
// the child container exits. It is removed only AFTER counters have been read.
// Hosts without an explicitly delegated cgroup subtree fail closed.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
  diskUsage,
  dockerRunArgs,
  MAX_JOB_DISK_BYTES,
  type ContainerRunner,
  type RunStatus,
} from "../docker.ts";
import type { ReexecSpec } from "../spec.ts";
import { readCgroupV2Counters } from "./cgroup.ts";
import { MeteringReceiptError } from "./receipt.ts";

const execFileAsync = promisify(execFile);
const PULL_TIMEOUT_MS = 600_000;
const COMMAND_TIMEOUT_MS = 120_000;
const DISK_POLL_MS = 1_000;
const EXIT_CODE = /^(0|[1-9][0-9]{0,2})$/;

/**
 * The host operator must pre-provision this subtree, not the untrusted job:
 *
 *   /sys/fs/cgroup/arl-metering
 *
 * Its cgroup.subtree_control must enable cpu and memory, and the validator host
 * user must be able to create child cgroups there. Docker must use cgroupfs on v2.
 */
export interface MeteredDockerOptions {
  docker?: string;
  cgroupRoot: string;
  maxDiskBytes?: number;
}

export function meteredDockerArgs(
  spec: ReexecSpec,
  workDir: string,
  outDir: string,
  name: string,
  cgroupParent: string,
): string[] {
  const args = dockerRunArgs(spec, workDir, outDir, name);
  if (args[0] !== "run" || args[1] !== "--rm") {
    throw new Error("unexpected DockerRunner argument contract");
  }
  // Docker must not delete the container automatically: final cgroup accounting
  // is collected from its persistent, separately created parent.
  args.splice(1, 1, "--detach", "--cgroup-parent", cgroupParent);
  return args;
}

async function docker(
  executable: string,
  args: string[],
  timeout = COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  try {
    const result = await execFileAsync(executable, args, {
      timeout,
      maxBuffer: 16_384,
      windowsHide: true,
      encoding: "utf8",
      ...(signal === undefined ? {} : { signal }),
    });
    return result.stdout.trim();
  } catch {
    throw new MeteringReceiptError(
      "METER_RUNTIME_FAILURE",
      signal?.aborted
        ? "metered Docker command cancelled"
        : "Docker command failed: " + (args[0] ?? "unknown"),
    );
  }
}

function controllersReady(value: string): boolean {
  const names = new Set(value.trim().split(/\s+/));
  return names.has("cpu") && names.has("memory");
}

function elapsedSafe(start: bigint): number {
  const elapsed = process.hrtime.bigint() - start;
  if (elapsed < 0n || elapsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MeteringReceiptError("INVALID_MEASUREMENT", "elapsed nanoseconds overflow");
  }
  return Number(elapsed);
}

export class MeteredDockerRunner implements ContainerRunner {
  readonly #docker: string;
  readonly #cgroupRoot: string;
  readonly #maxDiskBytes: number;

  constructor(options: MeteredDockerOptions) {
    if (
      !isAbsolute(options.cgroupRoot) ||
      !/^\/sys\/fs\/cgroup\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(options.cgroupRoot)
    ) {
      throw new MeteringReceiptError(
        "METER_COUNTERS_UNAVAILABLE",
        "cgroupRoot must be a trusted subtree under /sys/fs/cgroup",
      );
    }
    this.#cgroupRoot = options.cgroupRoot;
    this.#docker = options.docker ?? "docker";
    this.#maxDiskBytes = options.maxDiskBytes ?? MAX_JOB_DISK_BYTES;
    if (!Number.isSafeInteger(this.#maxDiskBytes) || this.#maxDiskBytes <= 0) {
      throw new Error("maxDiskBytes must be a positive safe integer");
    }
  }

  async run(
    spec: ReexecSpec,
    workDir: string,
    outDir: string,
    signal?: AbortSignal,
  ): Promise<RunStatus> {
    if (process.platform !== "linux") {
      throw new MeteringReceiptError("METER_COUNTERS_UNAVAILABLE", "Linux host required");
    }
    signal?.throwIfAborted();

    const [actualRoot, enabled, driver] = await Promise.all([
      realpath(this.#cgroupRoot),
      readFile(join(this.#cgroupRoot, "cgroup.subtree_control"), "utf8"),
      docker(this.#docker, ["info", "--format", "{{.CgroupVersion}}/{{.CgroupDriver}}"], COMMAND_TIMEOUT_MS, signal),
    ]).catch(() => {
      throw new MeteringReceiptError(
        "METER_COUNTERS_UNAVAILABLE",
        "delegated cgroup v2 and Docker runtime must be available",
      );
    });

    if (
      actualRoot !== this.#cgroupRoot ||
      !controllersReady(enabled) ||
      driver !== "2/cgroupfs"
    ) {
      throw new MeteringReceiptError(
        "METER_COUNTERS_UNAVAILABLE",
        "requires cgroup v2, enabled cpu+memory and Docker cgroupfs driver",
      );
    }

    // Pull is explicitly outside the metered execution interval.
    await docker(this.#docker, ["pull", "-q", spec.container_digest], PULL_TIMEOUT_MS, signal);
    signal?.throwIfAborted();

    const name = "arl-meter-" + randomBytes(12).toString("hex");
    const parent = join(this.#cgroupRoot, name);
    const dockerParent = parent.slice("/sys/fs/cgroup".length);
    await mkdir(parent, { mode: 0o700 });

    const state = {
      containerStarted: false,
      timedOut: false,
      tooLarge: false,
      cancelled: false,
      pollFailure: false,
      polling: undefined as Promise<void> | undefined,
      stopped: false,
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let diskTimer: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      void docker(this.#docker, ["kill", name], 15_000).catch(() => undefined);
    };
    const onAbort = () => {
      state.cancelled = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanupContainer = async (): Promise<void> => {
      // Always force-remove the named container, including on timeout, cancellation
      // or when a Docker CLI invocation failed partway through container creation.
      let cleanupError: Error | undefined;
      try {
        if (state.containerStarted || state.cancelled || state.timedOut) {
          await docker(this.#docker, ["rm", "-f", name], 30_000);
        } else {
          // The detached run may have created a container before its CLI failed.
          await docker(this.#docker, ["rm", "-f", name], 30_000).catch(() => undefined);
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error("cleanup failed");
      }
      try {
        await rmdir(parent);
      } catch {
        cleanupError = new MeteringReceiptError(
          "METER_RUNTIME_FAILURE",
          "cgroup parent cleanup failed; manual inspection required",
        );
      }
      if (cleanupError !== undefined) throw cleanupError;
    };

    try {
      // For nested Docker container cgroups, delegate cpu and memory to this
      // newly created, empty accounting parent.
      await writeFile(join(parent, "cgroup.subtree_control"), "+cpu +memory");
      await readCgroupV2Counters(parent);
      signal?.throwIfAborted();

      const started_at = Math.floor(Date.now() / 1000);
      const monotonicStart = process.hrtime.bigint();
      timeout = setTimeout(() => {
        state.timedOut = true;
        stop();
      }, spec.limits.seconds * 1000);

      const args = meteredDockerArgs(spec, workDir, outDir, name, dockerParent);
      const id = await docker(this.#docker, args, COMMAND_TIMEOUT_MS, signal);
      if (!/^[0-9a-f]{64}$/.test(id)) {
        throw new MeteringReceiptError("METER_RUNTIME_FAILURE", "invalid Docker container ID");
      }
      state.containerStarted = true;

      // Fail closed if Docker ignored the requested accounting parent.
      const actualParent = await docker(
        this.#docker,
        ["inspect", "--format", "{{.HostConfig.CgroupParent}}", name],
        COMMAND_TIMEOUT_MS,
        signal,
      );
      if (actualParent !== dockerParent) {
        throw new MeteringReceiptError(
          "METER_COUNTERS_UNAVAILABLE",
          "wrong container cgroup parent",
        );
      }
      if (signal?.aborted || state.timedOut) stop();

      diskTimer = setInterval(() => {
        if (state.polling || state.stopped) return;
        state.polling = (async () => {
          try {
            const used =
              (await diskUsage(outDir, this.#maxDiskBytes)) +
              (await diskUsage(workDir, this.#maxDiskBytes));
            if (used > this.#maxDiskBytes) {
              state.tooLarge = true;
              stop();
            }
          } catch {
            state.pollFailure = true;
            stop();
          }
        })().finally(() => {
          state.polling = undefined;
        });
      }, DISK_POLL_MS);

      const status = await docker(
        this.#docker,
        ["wait", name],
        spec.limits.seconds * 1000 + 30_000,
        signal,
      );
      const finished_at = Math.floor(Date.now() / 1000);
      const elapsed_ns = elapsedSafe(monotonicStart);
      state.stopped = true;
      clearInterval(diskTimer);
      if (state.polling) await state.polling;

      if (state.cancelled || signal?.aborted) {
        throw new MeteringReceiptError("METER_RUNTIME_FAILURE", "metered job cancelled");
      }
      if (state.tooLarge || state.pollFailure) {
        throw new MeteringReceiptError("METER_RUNTIME_FAILURE", "job disk accounting failed");
      }
      // A short-lived container can exit before the first one-second disk poll.
      // Check the final work/output footprint even when no periodic poll ran.
      const finalDiskBytes =
        (await diskUsage(outDir, this.#maxDiskBytes)) +
        (await diskUsage(workDir, this.#maxDiskBytes));
      if (finalDiskBytes > this.#maxDiskBytes) {
        throw new MeteringReceiptError(
          "METER_RUNTIME_FAILURE",
          "job exceeded its final work/output disk budget",
        );
      }
      if (state.timedOut) return { exitCode: null, timedOut: true };
      if (!EXIT_CODE.test(status) || Number(status) > 255) {
        throw new MeteringReceiptError("METER_RUNTIME_FAILURE", "invalid Docker exit status");
      }
      const exitCode = Number(status);

      // This parent persists even after Docker destroys its child cgroup.
      // Never replace these values with sampled docker stats or Node.js usage.
      const counters = await readCgroupV2Counters(parent);
      if (counters.memoryPeakBytes === 0) {
        throw new MeteringReceiptError(
          "METER_COUNTERS_UNAVAILABLE",
          "container did not produce observable hierarchical memory accounting",
        );
      }
      if (exitCode !== 0) return { exitCode, timedOut: false };

      return {
        exitCode,
        timedOut: false,
        metering: {
          started_at,
          finished_at,
          elapsed_ns,
          cpu_time_ns: counters.cpuTimeNs,
          memory_peak_bytes: counters.memoryPeakBytes,
        },
      };
    } finally {
      state.stopped = true;
      if (timeout) clearTimeout(timeout);
      if (diskTimer) clearInterval(diskTimer);
      signal?.removeEventListener("abort", onAbort);

      await cleanupContainer();
    }
  }
}
