// arl-metering-vote/1 commits an independently checked result hash and a signed receipt hash
// through ARLVerifiedEvaluator.vote(..., bytes32 evidence). No contract change is required.

import type { Hex } from "viem";

import { canonicalHash } from "../canonical.ts";
import { acceptance, resultHash, type ResultManifest } from "../result.ts";
import { specHash, type ReexecSpec } from "../spec.ts";
import {
  MeteringReceiptError,
  verifyMeteringReceipt,
  type MeteringVerificationContext,
  type SignedMeteringReceipt,
  type VerifiedMeteringReceipt,
} from "./receipt.ts";
import type { MeteringReplayStore } from "./replay.ts";

export const METERING_VOTE_VERSION = "arl-metering-vote/1";

export interface MeteringVoteEvidence {
  version: typeof METERING_VOTE_VERSION;
  result_hash: Hex;
  receipt_hash: Hex;
}

export interface MeteredEvidenceInput {
  spec: ReexecSpec;
  result: ResultManifest;
  receipt: SignedMeteringReceipt;
  /** The expected signer MUST come from independent authenticated registration. */
  context: MeteringVerificationContext;
}

export interface MeteredApprovalInput extends MeteredEvidenceInput {
  /** Provisional, explicitly configured per-validator durable replay policy. */
  replay: MeteringReplayStore;
}

export interface MeteredApproval {
  composite: MeteringVoteEvidence;
  evidenceHash: Hex;
}

async function calculateEvidence(
  input: MeteredEvidenceInput,
): Promise<{ approval: MeteredApproval; verified: VerifiedMeteringReceipt }> {
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
  const composite: MeteringVoteEvidence = {
    version: METERING_VOTE_VERSION,
    result_hash: computedResultHash,
    receipt_hash: verified.receiptHash,
  };
  return {
    approval: { composite, evidenceHash: canonicalHash(composite) },
    verified,
  };
}

/**
 * Independent, read-only verifier for an observed on-chain evidence hash.
 *
 * No durable replay state is consumed and no transaction is sent. The caller must obtain
 * expectedSigner from an authenticated provider registration, and independently obtain the
 * re-execution ResultManifest. This verifies hash bindings and signature authenticity
 * under trusted-host assumptions; it is not hardware usage attestation.
 */
export async function verifyMeteredEvidence(
  input: MeteredEvidenceInput & { expectedEvidenceHash: Hex },
): Promise<MeteredApproval> {
  if (!/^0x[0-9a-f]{64}$/.test(input.expectedEvidenceHash)) {
    throw new MeteringReceiptError("COMPOSITE_HASH_MISMATCH", "evidence must be lowercase bytes32");
  }
  const { approval } = await calculateEvidence(input);
  if (approval.evidenceHash !== input.expectedEvidenceHash) {
    throw new MeteringReceiptError(
      "COMPOSITE_HASH_MISMATCH",
      "on-chain vote evidence differs from verified result and signed receipt",
    );
  }
  return approval;
}

/**
 * Assemble an approval for a future vote, reserving replay state only AFTER all signature
 * and result checks succeed. The caller still must confirm the current job's vote eligibility.
 */
export async function buildMeteredApproval(input: MeteredApprovalInput): Promise<MeteredApproval> {
  const { approval, verified } = await calculateEvidence(input);
  await input.replay.consume(verified);
  return approval;
}
