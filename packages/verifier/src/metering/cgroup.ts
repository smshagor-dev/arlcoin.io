// Host-side Linux cgroup v2 counter decoding. The Docker lifecycle is responsible for
// identifying the target container's cgroup and keeping it alive until the final read.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { MeteringReceiptError } from "./receipt.ts";

export interface CgroupV2Counters {
  cpuTimeNs: number;
  memoryPeakBytes: number;
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function counter(raw: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new MeteringReceiptError(
      "METER_COUNTERS_UNAVAILABLE",
      name + " must be a nonnegative decimal kernel counter",
    );
  }
  return BigInt(raw);
}

/** Parse usage_usec from cpu.stat, rejecting missing or duplicate usage fields. */
export function parseCgroupCpuStat(contents: string): bigint {
  let usage: bigint | undefined;
  for (const line of contents.trim().split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^([a-z0-9_.]+) ([0-9]+)$/.exec(trimmed);
    if (match === null) {
      throw new MeteringReceiptError("METER_COUNTERS_UNAVAILABLE", "invalid cpu.stat line");
    }
    const key = match[1];
    const value = match[2];
    if (key === "usage_usec") {
      if (usage !== undefined || value === undefined) {
        throw new MeteringReceiptError("METER_COUNTERS_UNAVAILABLE", "duplicate usage_usec");
      }
      usage = counter(value, "usage_usec");
    }
  }
  if (usage === undefined) {
    throw new MeteringReceiptError("METER_COUNTERS_UNAVAILABLE", "cpu.stat lacks usage_usec");
  }
  return usage * 1000n;
}

/** memory.peak is a cumulative peak for this isolated cgroup, not sampled Docker stats. */
export function parseCgroupMemoryPeak(contents: string): bigint {
  return counter(contents.trim(), "memory.peak");
}

function safeNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX) {
    throw new MeteringReceiptError(
      "METER_COUNTERS_UNAVAILABLE",
      field + " is outside the signed receipt's safe-integer range",
    );
  }
  return Number(value);
}

/**
 * A final read must happen while the container's cgroup still exists. Missing counters,
 * unreadable files, unsupported cgroup mode and overflow all fail closed.
 */
export async function readCgroupV2Counters(cgroupDirectory: string): Promise<CgroupV2Counters> {
  if (!cgroupDirectory.startsWith("/") || cgroupDirectory.includes("\0")) {
    throw new MeteringReceiptError(
      "METER_COUNTERS_UNAVAILABLE",
      "expected a trusted absolute cgroup directory",
    );
  }
  try {
    const [controllers, cpu, memory] = await Promise.all([
      readFile(join(cgroupDirectory, "cgroup.controllers"), "utf8"),
      readFile(join(cgroupDirectory, "cpu.stat"), "utf8"),
      readFile(join(cgroupDirectory, "memory.peak"), "utf8"),
    ]);
    if (typeof controllers !== "string") {
      throw new MeteringReceiptError("METER_COUNTERS_UNAVAILABLE", "cgroup v2 unavailable");
    }
    return {
      cpuTimeNs: safeNumber(parseCgroupCpuStat(cpu), "cpu_time_ns"),
      memoryPeakBytes: safeNumber(parseCgroupMemoryPeak(memory), "memory_peak_bytes"),
    };
  } catch (error) {
    if (error instanceof MeteringReceiptError) throw error;
    throw new MeteringReceiptError(
      "METER_COUNTERS_UNAVAILABLE",
      "unable to collect Linux cgroup v2 counters",
    );
  }
}
