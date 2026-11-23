// Provider-side receipt construction from ONE successfully metered execution.
// Never give the private metering key to a validator or sign metrics for a failed run.

import { randomBytes } from "node:crypto";

import type { Address, Hex } from "viem";

import type { Execution } from "../verify.ts";
import { acceptance, resultHash } from "../result.ts";
import { specHash, type ReexecSpec } from "../spec.ts";
import {
  MeteringReceiptError,
  signMeteringReceipt,
  type MeteringReceipt,
  type SignedMeteringReceipt,
} from "./receipt.ts";

export interface MeteringProducerIdentity {
  chainId: number;
  evaluatorAddress: Address;
  jobId: string;
  /** This separate private key must remain solely on the provider's trusted meter host. */
  meterPrivateKey: Hex;
  meterVersion?: string;
}

/** Builds a signed receipt only if a real metered run passed the existing result checks. */
export async function produceMeteringReceipt(
  spec: ReexecSpec,
  execution: Execution,
  identity: MeteringProducerIdentity,
): Promise<SignedMeteringReceipt> {
  const measurements = execution.metering;
  if (!measurements) {
    throw new MeteringReceiptError(
      "METER_COUNTERS_UNAVAILABLE",
      "execution did not contain actual cgroup metering counters",
    );
  }
  const computedSpecHash = specHash(spec);
  if (execution.result.spec_hash !== computedSpecHash) {
    throw new MeteringReceiptError("SPEC_MISMATCH", "execution used a different specification");
  }
  if (execution.result.timed_out || execution.result.exit_code !== 0) {
    throw new MeteringReceiptError("REEXECUTION_REJECTED", "run did not complete successfully");
  }
  if (!acceptance(spec, execution.result).ok) {
    throw new MeteringReceiptError("REEXECUTION_REJECTED", "result violates committed acceptance");
  }
  if (resultHash(execution.result) !== execution.hash) {
    throw new MeteringReceiptError("DELIVERABLE_MISMATCH", "execution result hash is inconsistent");
  }

  const receipt: MeteringReceipt = {
    version: "arl-metering-receipt/1",
    chain_id: identity.chainId,
    // Ethereum clients may return EIP-55 checksummed addresses; the canonical
    // signed receipt format intentionally requires lowercase hex.
    evaluator_address: identity.evaluatorAddress.toLowerCase() as Address,
    job_id: identity.jobId,
    spec_hash: computedSpecHash,
    deliverable_hash: execution.hash,
    run_id: ("0x" + randomBytes(32).toString("hex")) as Hex,
    nonce: ("0x" + randomBytes(32).toString("hex")) as Hex,
    container_digest: spec.container_digest,
    meter_version: identity.meterVersion ?? "arl-meter-runner/0.1.0",
    meter_source: "linux-cgroup-v2",
    trust_level: "trusted-host/software",
    started_at: measurements.started_at,
    finished_at: measurements.finished_at,
    elapsed_ns: measurements.elapsed_ns,
    cpu_time_ns: measurements.cpu_time_ns,
    memory_peak_bytes: measurements.memory_peak_bytes,
    gpu_metrics: null,
  };
  return signMeteringReceipt(receipt, identity.meterPrivateKey);
}
