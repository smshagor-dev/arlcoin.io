import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { dockerRunArgs } from "../src/docker.ts";
import { meteredDockerArgs, MeteredDockerRunner } from "../src/metering/runner.ts";
import { produceMeteringReceipt } from "../src/metering/produce.ts";
import { verifyMeteringReceipt } from "../src/metering/receipt.ts";
import { resultHash, type ResultManifest } from "../src/result.ts";
import { parseSpec, specHash } from "../src/spec.ts";
import type { Execution } from "../src/verify.ts";

const key = keccak256(stringToBytes("arl-metering-test-vector-only-not-private"));
const signer = privateKeyToAccount(key).address;
const spec = parseSpec({
  version: "arl-reexec/1",
  container_digest: "docker.io/library/busybox@sha256:" + "aa".repeat(32),
  inputs: [],
  command: ["/bin/true"],
  workdir: ".",
  env: {},
  outputs: ["result.txt"],
  limits: { seconds: 15, memory_mb: 128, cpus: 2 },
  expected_exit_code: 0,
  verifier_digest: "sha256:" + "bb".repeat(32),
});
const result: ResultManifest = {
  version: "arl-reexec-result/1",
  spec_hash: specHash(spec),
  exit_code: 0,
  timed_out: false,
  outputs: [{ path: "result.txt", sha256: null }],
};
const execution: Execution = {
  result,
  hash: resultHash(result),
  metering: {
    started_at: 1795410000,
    finished_at: 1795410002,
    elapsed_ns: 1_500_000_000,
    cpu_time_ns: 1_120_000_000,
    memory_peak_bytes: 16_777_216,
  },
};
const identity = {
  chainId: 31337,
  evaluatorAddress: "0x1000000000000000000000000000000000000001" as const,
  jobId: "7",
  meterPrivateKey: key,
};

describe("metered Docker argument and provider receipt construction", () => {
  it("retains original workload isolation while moving cleanup outside docker run", () => {
    const original = dockerRunArgs(spec, "/work-in", "/work-out", "arl-test");
    const args = meteredDockerArgs(
      spec,
      "/work-in",
      "/work-out",
      "arl-test",
      "/arl-metering/arl-test",
    );
    assert.deepEqual(original.filter((x) => x !== "--rm"), args.slice(0, 1).concat(args.slice(4)));
    assert.deepEqual(args.slice(1, 4), ["--detach", "--cgroup-parent", "/arl-metering/arl-test"]);
    assert.equal(args.includes("--rm"), false);
    for (const option of ["--network", "none", "--read-only", "--cap-drop", "--pids-limit"]) {
      assert.ok(args.includes(option));
    }
  });

  it("rejects a non-cgroup path at configuration time", () => {
    assert.throws(
      () => new MeteredDockerRunner({ cgroupRoot: "/tmp/not-a-cgroup" }),
      { code: "METER_COUNTERS_UNAVAILABLE" },
    );
  });

  it("signs actual provided measurements and binds to the deterministic result", async () => {
    const first = await produceMeteringReceipt(spec, execution, identity);
    const second = await produceMeteringReceipt(spec, execution, identity);
    assert.notEqual(first.receipt.nonce, second.receipt.nonce);
    assert.notEqual(first.receipt.run_id, second.receipt.run_id);
    assert.equal(first.receipt.cpu_time_ns, execution.metering?.cpu_time_ns);
    assert.equal(first.receipt.deliverable_hash, resultHash(result));

    const context = {
      chainId: identity.chainId,
      evaluatorAddress: identity.evaluatorAddress,
      jobId: identity.jobId,
      specHash: specHash(spec),
      deliverableHash: resultHash(result),
      containerDigest: spec.container_digest,
      expectedSigner: signer,
    };
    const verified = await verifyMeteringReceipt(first, context);
    assert.equal(verified.receiptHash.length, 66);
    await assert.rejects(
      () =>
        verifyMeteringReceipt(first, {
          ...context,
          expectedSigner: "0x7777777777777777777777777777777777777777",
        }),
      { code: "SIGNER_MISMATCH" },
    );
  });

  it("never signs an unmetered, failed, timed-out or result-mismatched run", async () => {
    const { metering: present, ...unmetered } = execution;
    assert.ok(present);
    await assert.rejects(
      () => produceMeteringReceipt(spec, unmetered, identity),
      { code: "METER_COUNTERS_UNAVAILABLE" },
    );
    await assert.rejects(
      () =>
        produceMeteringReceipt(
          spec,
          { ...execution, result: { ...result, exit_code: 1 } },
          identity,
        ),
      { code: "REEXECUTION_REJECTED" },
    );
    await assert.rejects(
      () =>
        produceMeteringReceipt(
          spec,
          { ...execution, result: { ...result, timed_out: true } },
          identity,
        ),
      { code: "REEXECUTION_REJECTED" },
    );
    await assert.rejects(
      () => produceMeteringReceipt(spec, { ...execution, hash: ("0x" + "77".repeat(32)) as typeof execution.hash }, identity),
      { code: "DELIVERABLE_MISMATCH" },
    );
  });
});
