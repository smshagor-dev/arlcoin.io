// Real Docker integration for a host with delegated Linux cgroup v2 + cgroupfs.
// Run with ARL_METERING_CGROUP_ROOT=/sys/fs/cgroup/arl-metering
// npm run test:docker -w @arl/verifier. The host must provision the subtree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { readPinnedMeteringArtifact } from "../src/metering/artifact.ts";
import { executeAndPublishMeteredReceipt } from "../src/metering/provider.ts";
import { verifyMeteringReceipt } from "../src/metering/receipt.ts";
import { parseSpec, specHash } from "../src/spec.ts";

const BUSYBOX =
  "docker.io/library/busybox@sha256:" +
  "bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const root = process.env.ARL_METERING_CGROUP_ROOT;

function supported(): boolean {
  if (process.platform !== "linux" || !root) return false;
  try {
    const driver = execFileSync(
      "docker",
      ["info", "--format", "{{.CgroupVersion}}/{{.CgroupDriver}}"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    return driver === "2/cgroupfs";
  } catch {
    return false;
  }
}

const ready = supported();

function job(command: string) {
  return parseSpec({
    version: "arl-reexec/1",
    container_digest: BUSYBOX,
    inputs: [],
    command: ["sh", "-c", command],
    workdir: ".",
    env: {},
    outputs: ["result.txt"],
    limits: { seconds: 60, memory_mb: 128, cpus: 2 },
    expected_exit_code: 0,
    verifier_digest: "sha256:" + "00".repeat(32),
  });
}

describe("metered Docker cgroup v2 integration", {
  skip: !ready && "requires delegated cgroup v2 + cgroupfs",
}, () => {
  it("runs real CPU/memory workload, signs receipt and publishes pinned artifact", async () => {
    assert.ok(root);
    const spec = job(
      "i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done; " +
        "dd if=/dev/zero of=/tmp/load bs=1M count=24 2>/dev/null; " +
        "echo done > /out/result.txt",
    );
    const directory = await mkdtemp(join(tmpdir(), "arl-metering-evidence-"));
    try {
      const receiptPath = join(directory, "receipt.json");
      const key = keccak256(stringToBytes("arl-metering-test-vector-only-not-private"));
      const { execution, publication } = await executeAndPublishMeteredReceipt(
        spec,
        {
          chainId: 31337,
          evaluatorAddress: "0x1000000000000000000000000000000000000001",
          jobId: "7",
          meterPrivateKey: key,
        },
        {
          cgroupRoot: root,
          receiptPath,
          fetcher: {
            file: () => Promise.reject(new Error("unexpected input fetch")),
            git: () => Promise.reject(new Error("unexpected input fetch")),
          },
        },
      );
      assert.equal(execution.result.timed_out, false);
      assert.equal(execution.result.exit_code, 0);
      assert.ok(execution.metering, "successful measured run must provide cgroup counters");
      assert.ok(execution.metering.cpu_time_ns > 0);
      assert.ok(execution.metering.memory_peak_bytes >= 24 * 1024 * 1024);
      assert.ok(execution.metering.elapsed_ns > 0);
      assert.ok(publication.byteLength > 0);
      assert.match(publication.sha256, /^0x[0-9a-f]{64}$/);

      const { signed } = await readPinnedMeteringArtifact(receiptPath, publication.sha256);
      const verified = await verifyMeteringReceipt(signed, {
        chainId: 31337,
        evaluatorAddress: signed.receipt.evaluator_address,
        jobId: "7",
        specHash: specHash(spec),
        deliverableHash: execution.hash,
        containerDigest: spec.container_digest,
        expectedSigner: privateKeyToAccount(key).address,
        nowSeconds: Math.floor(Date.now() / 1000),
        maxReceiptAgeSeconds: 300,
        maxFutureSkewSeconds: 5,
      });
      assert.equal(verified.receiptHash.length, 66);

    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
