import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { keccak256, stringToBytes, type Address, type Hex } from "viem";

import { canonicalHash } from "../src/canonical.ts";
import { buildMeteredApproval, METERING_VOTE_VERSION } from "../src/metering/evidence.ts";
import { FileMeteringReplayStore } from "../src/metering/replay.ts";
import {
  signMeteringReceipt,
  type MeteringReceipt,
  type MeteringVerificationContext,
} from "../src/metering/receipt.ts";
import { resultHash, type ResultManifest } from "../src/result.ts";
import { parseSpec, specHash } from "../src/spec.ts";

const key = keccak256(stringToBytes("arl-metering-test-vector-only-not-private"));
const expectedSigner: Address = "0x281c6e8b0cc09df345fb88c4cb30201d561a5c5e";
const spec = parseSpec({
  version: "arl-reexec/1",
  container_digest: "docker.io/library/busybox@sha256:" + "aa".repeat(32),
  inputs: [],
  command: ["/bin/true"],
  workdir: ".",
  env: {},
  outputs: ["results.json"],
  limits: { seconds: 10, memory_mb: 64, cpus: 1 },
  verifier_digest: "sha256:" + "bb".repeat(32),
});

const result: ResultManifest = {
  version: "arl-reexec-result/1",
  spec_hash: specHash(spec),
  exit_code: 0,
  timed_out: false,
  outputs: [{ path: "results.json", sha256: null }],
};

function receiptFor(manifest: ResultManifest): MeteringReceipt {
  return {
    version: "arl-metering-receipt/1",
    chain_id: 31337,
    evaluator_address: "0x1000000000000000000000000000000000000001",
    job_id: "7",
    spec_hash: specHash(spec),
    deliverable_hash: resultHash(manifest),
    run_id: ("0x" + "33".repeat(32)) as Hex,
    nonce: ("0x" + "44".repeat(32)) as Hex,
    container_digest: spec.container_digest,
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
}

function contextFor(manifest: ResultManifest): MeteringVerificationContext {
  return {
    chainId: 31337,
    evaluatorAddress: "0x1000000000000000000000000000000000000001",
    jobId: "7",
    specHash: specHash(spec),
    deliverableHash: resultHash(manifest),
    containerDigest: spec.container_digest,
    expectedSigner,
  };
}

describe("arl-metering-vote/1 evidence construction", () => {
  it("commits independent validator result and authenticated meter receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arl-meter-vote-"));
    try {
      const receipt = await signMeteringReceipt(receiptFor(result), key);
      const replay = new FileMeteringReplayStore(directory);
      const approved = await buildMeteredApproval({
        spec,
        result,
        receipt,
        context: contextFor(result),
        replay,
      });
      assert.equal(approved.composite.version, METERING_VOTE_VERSION);
      assert.equal(approved.composite.result_hash, resultHash(result));
      assert.equal(approved.composite.receipt_hash, canonicalHash(receipt.receipt));
      assert.equal(approved.evidenceHash, canonicalHash(approved.composite));
      assert.notEqual(approved.evidenceHash, approved.composite.receipt_hash);
      await assert.rejects(
        () => buildMeteredApproval({ spec, result, receipt, context: contextFor(result), replay }),
        { code: "REPLAY_DETECTED" },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not consume replay state when result verification fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arl-meter-failure-"));
    try {
      const receipt = await signMeteringReceipt(receiptFor(result), key);
      const replay = new FileMeteringReplayStore(directory);
      const manipulatedResult: ResultManifest = {
        ...result,
        outputs: [{ path: "results.json", sha256: "00".repeat(32) }],
      };
      await assert.rejects(
        () =>
          buildMeteredApproval({
            spec,
            result: manipulatedResult,
            receipt,
            context: contextFor(result),
            replay,
          }),
        { code: "DELIVERABLE_MISMATCH" },
      );
      const success = await buildMeteredApproval({
        spec,
        result,
        receipt,
        context: contextFor(result),
        replay,
      });
      assert.equal(success.composite.result_hash, resultHash(result));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a correctly signed receipt for a failed validator re-execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arl-meter-reject-"));
    try {
      const failed: ResultManifest = { ...result, timed_out: true };
      const signed = await signMeteringReceipt(receiptFor(failed), key);
      await assert.rejects(
        () =>
          buildMeteredApproval({
            spec,
            result: failed,
            receipt: signed,
            context: contextFor(failed),
            replay: new FileMeteringReplayStore(directory),
          }),
        { code: "REEXECUTION_REJECTED" },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
