// Real Docker integration for a host with delegated Linux cgroup v2 + cgroupfs.
// Run with ARL_METERING_CGROUP_ROOT=/sys/fs/cgroup/arl-metering
// npm run test:docker -w @arl/verifier. The host must provision the subtree.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { MeteredDockerRunner } from "../src/metering/runner.ts";
import { produceMeteringReceipt } from "../src/metering/produce.ts";
import { verifyMeteringReceipt } from "../src/metering/receipt.ts";
import { execute } from "../src/verify.ts";
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
  it("measures real CPU load and peak memory then verifies its signed receipt", async () => {
    assert.ok(root);
    const spec = job(
      "i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done; " +
        "dd if=/dev/zero of=/tmp/load bs=1M count=24 2>/dev/null; " +
        "echo done > /out/result.txt",
    );
    const runner = new MeteredDockerRunner({ cgroupRoot: root });
    const execution = await execute(spec, {
      runner,
      fetcher: {
        file: () => Promise.reject(new Error("unexpected input fetch")),
        git: () => Promise.reject(new Error("unexpected input fetch")),
      },
    });
    assert.equal(execution.result.timed_out, false);
    assert.equal(execution.result.exit_code, 0);
    assert.ok(execution.metering, "metering must be present for a successful run");
    assert.ok(execution.metering.cpu_time_ns > 0);
    assert.ok(execution.metering.memory_peak_bytes >= 24 * 1024 * 1024);
    assert.ok(execution.metering.elapsed_ns > 0);

    const key = keccak256(stringToBytes("arl-metering-test-vector-only-not-private"));
    const signed = await produceMeteringReceipt(spec, execution, {
      chainId: 31337,
      evaluatorAddress: "0x1000000000000000000000000000000000000001",
      jobId: "7",
      meterPrivateKey: key,
    });
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
  });
});
