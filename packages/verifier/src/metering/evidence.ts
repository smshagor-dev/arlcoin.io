// arl-metering-vote/1 is a versioned, off-chain composite committed through the existing
// ARLVerifiedEvaluator.vote(..., bytes32 evidence). No Solidity change is required.
// This builder must not be called for an unverified receipt or an unaccepted re-execution.

import type { Hex } from "viem";

import { canonicalHash } from "../canonical.ts";
import { acceptance, resultHash, type ResultManifest } from "../result.ts";
import { specHash, type ReexecSpec } from "../spec.ts";
import {
  MeteringReceiptError,
  verifyMeteringReceipt,
  type MeteringVerificationContext,
  type SignedMeteringReceipt,
} from "./receipt.ts";
import type { MeteringReplayStore } from "./replay.ts";

export const METERING_VOTE_VERSION = "arl-metering-vote/1";

export interface MeteringVoteEvidence {
  version: typeof METERING_VOTE_VERSION;
  result_hash: Hex;
  receipt_hash: Hex;
}

export interface MeteredApprovalInput {
  spec: ReexecSpec;
  result: ResultManifest;
  receipt: SignedMeteringReceipt;
  context: MeteringVerificationContext;
  /** Provisional, explicitly configured per-job durable replay policy. */
  replay: MeteringReplayStore;
}

export interface MeteredApproval {
  composite: MeteringVoteEvidence;
  evidenceHash: Hex;
}

/**
 * Commit exactly two independently obtained values:
 * - result_hash computed from the validator's own result manifest;
 * - receipt_hash computed after authorized signature verification.
 *
 * Once this returns, a validator may submit evidenceHash as the existing vote evidence
 * with approve=true. Do not call this during a failed or skipped re-execution.
 */
export async function buildMeteredApproval(input: MeteredApprovalInput): Promise<MeteredApproval> {
  const committedSpecHash = specHash(input.spec);
  if (committedSpecHash !== input.context.specHash) {
    throw new MeteringReceiptError("SPEC_MISMATCH", "job spec commitment does not match");
  }
  if (input.result.spec_hash !== committedSpecHash) {
    throw new MeteringReceiptError("SPEC_MISMATCH", "re-execution result is for another spec");
  }
  const computedResultHash = resultHash(input.result);
  if (computedResultHash !== input.context.deliverableHash) {
    throw new MeteringReceiptError(
      "DELIVERABLE_MISMATCH",
      "validator result does not match the on-chain deliverable",
    );
  }
  const accepted = acceptance(input.spec, input.result);
  if (!accepted.ok) {
    throw new MeteringReceiptError(
      "REEXECUTION_REJECTED",
      "validator result did not satisfy the spec: " + accepted.reason,
    );
  }
  const verified = await verifyMeteringReceipt(input.receipt, input.context);
  await input.replay.consume(verified);

  const composite: MeteringVoteEvidence = {
    version: METERING_VOTE_VERSION,
    result_hash: computedResultHash,
    receipt_hash: verified.receiptHash,
  };
  return { composite, evidenceHash: canonicalHash(composite) };
}
