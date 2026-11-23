import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  parseCgroupCpuStat,
  parseCgroupMemoryPeak,
  readCgroupV2Counters,
} from "../src/metering/cgroup.ts";

describe("Linux cgroup v2 counter reader", () => {
  it("converts cumulative process-tree CPU microseconds into nanoseconds", () => {
    assert.equal(
      parseCgroupCpuStat(
        "usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\nnr_periods 17\nnr_throttled 2\n",
      ),
      123_456_000n,
    );
    assert.equal(parseCgroupCpuStat("usage_usec 0\n"), 0n);
    assert.equal(parseCgroupMemoryPeak("16777216\n"), 16_777_216n);
  });

  it("fails on missing, duplicate or nonnumeric kernel counters", () => {
    assert.throws(() => parseCgroupCpuStat("user_usec 4\n"), {
      code: "METER_COUNTERS_UNAVAILABLE",
    });
    assert.throws(() => parseCgroupCpuStat("usage_usec 1\nusage_usec 2\n"), {
      code: "METER_COUNTERS_UNAVAILABLE",
    });
    assert.throws(() => parseCgroupCpuStat("usage_usec -1\n"), {
      code: "METER_COUNTERS_UNAVAILABLE",
    });
    assert.throws(() => parseCgroupMemoryPeak("max\n"), {
      code: "METER_COUNTERS_UNAVAILABLE",
    });
  });

  it(
    "reads the actual cgroup file interface, not Node process or docker stats",
    { skip: process.platform !== "linux" && "requires Linux cgroup file semantics" },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "arl-metering-cgroup-"));
      try {
        await Promise.all([
          writeFile(join(directory, "cgroup.controllers"), "cpu memory io\n"),
          writeFile(join(directory, "cpu.stat"), "usage_usec 45678\nuser_usec 45000\nnr_periods 3\n"),
          writeFile(join(directory, "memory.peak"), "9876543\n"),
        ]);
        const counters = await readCgroupV2Counters(directory);
        assert.deepEqual(counters, {
          cpuTimeNs: 45_678_000,
          memoryPeakBytes: 9_876_543,
        });
        await writeFile(join(directory, "memory.peak"), "9007199254740992\n");
        await assert.rejects(() => readCgroupV2Counters(directory), {
          code: "METER_COUNTERS_UNAVAILABLE",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("fails closed if the cgroup was removed before final readings", async () => {
    await assert.rejects(
      () => readCgroupV2Counters(join(tmpdir(), "arl-no-such-metering-cgroup")),
      { code: "METER_COUNTERS_UNAVAILABLE" },
    );
  });
});
