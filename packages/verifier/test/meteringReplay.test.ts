import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileMeteringReplayStore } from "../src/metering/replay.ts";
import type { MeteringReceipt, VerifiedMeteringReceipt } from "../src/metering/receipt.ts";

const baseReceipt: MeteringReceipt = {
  version: "arl-metering-receipt/1",
  chain_id: 31337,
  evaluator_address: "0x1000000000000000000000000000000000000001",
  job_id: "7",
  spec_hash: ("0x" + "11".repeat(32)) as MeteringReceipt["spec_hash"],
  deliverable_hash: ("0x" + "22".repeat(32)) as MeteringReceipt["deliverable_hash"],
  run_id: ("0x" + "33".repeat(32)) as MeteringReceipt["run_id"],
  nonce: ("0x" + "44".repeat(32)) as MeteringReceipt["nonce"],
  container_digest: "docker.io/library/busybox@sha256:" + "aa".repeat(32),
  meter_version: "arl-meter-runner/0.1.0",
  meter_source: "linux-cgroup-v2",
  trust_level: "trusted-host/software",
  started_at: 1795410000,
  finished_at: 1795410002,
  elapsed_ns: 1_500_000_000,
  cpu_time_ns: 1_120_000_000,
  memory_peak_bytes: 16_777_216,
  gpu_metrics: null,
};

function verified(patch: Partial<MeteringReceipt> = {}): VerifiedMeteringReceipt {
  return {
    receipt: { ...baseReceipt, ...patch },
    receiptHash: ("0x" + "aa".repeat(32)) as VerifiedMeteringReceipt["receiptHash"],
    signer: "0x281c6e8b0cc09df345fb88c4cb30201d561a5c5e",
  };
}

describe("durable provisional job-level replay reservation", () => {
  it("rejects a repeated receipt after re-creating the store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arl-replay-"));
    try {
      const first = new FileMeteringReplayStore(directory, "0x9999999999999999999999999999999999999999");
      await first.consume(verified());
      const restarted = new FileMeteringReplayStore(directory, "0x9999999999999999999999999999999999999999");
      await assert.rejects(() => restarted.consume(verified()), { code: "REPLAY_DETECTED" });
      assert.equal((await readdir(directory)).length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows exactly one concurrent reservation of the same job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arl-replay-concurrent-"));
    try {
      const first = new FileMeteringReplayStore(directory, "0x9999999999999999999999999999999999999999");
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => first.consume(verified())),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const failures = results.filter((r) => r.status === "rejected");
      assert.equal(failures.length, 11);
      assert.ok(
        failures.every(
          (r) => r.status === "rejected" &&
            r.reason instanceof Error &&
            "code" in r.reason &&
            r.reason.code === "REPLAY_DETECTED",
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a different nonce or run ID for an already reserved job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arl-replay-scope-"));
    try {
      const store = new FileMeteringReplayStore(directory, "0x9999999999999999999999999999999999999999");
      await store.consume(verified());
      await assert.rejects(
        () => store.consume(verified({ nonce: ("0x" + "55".repeat(32)) as MeteringReceipt["nonce"] })),
        { code: "REPLAY_DETECTED" },
      );
      await assert.rejects(
        () => store.consume(verified({ run_id: ("0x" + "66".repeat(32)) as MeteringReceipt["run_id"] })),
        { code: "REPLAY_DETECTED" },
      );
      await store.consume(verified({ job_id: "8" }));
      await store.consume(verified({ chain_id: 8453 }));
      await new FileMeteringReplayStore(
        directory,
        "0x8888888888888888888888888888888888888888",
      ).consume(verified());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
