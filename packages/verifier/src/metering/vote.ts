// Opt-in, fail-closed metered vote. This does not change the legacy validator watcher.
// Metering is approved only after checking live chain state and a historically pinned
// ERC-8004 provider registration; the validator never handles the provider meter key.

import type { Hex, PublicClient } from "viem";

import {
  castVote,
  JobStatus,
  MemberState,
  Phase,
  readJob,
} from "../chain.ts";
import type { ResultManifest } from "../result.ts";
import type { ReexecSpec } from "../spec.ts";
import { buildMeteredApproval, type MeteredApproval } from "./evidence.ts";
import { MeteringReceiptError, type SignedMeteringReceipt } from "./receipt.ts";
import {
  resolveMeterSigner,
  type MeterRegistrationSnapshot,
} from "./registration.ts";
import type { MeteringReplayStore } from "./replay.ts";

type ValidatorWallet = Parameters<typeof castVote>[0];
type Evaluator = Parameters<typeof castVote>[2];

export interface MeteredJobVoteInput {
  client: PublicClient;
  wallet: ValidatorWallet;
  evaluator: Evaluator;
  jobId: bigint;
  /** The validator's own re-execution result, not a provider-supplied result. */
  result: ResultManifest;
  spec: ReexecSpec;
  receipt: SignedMeteringReceipt;
  /** Independent registration metadata bytes and trusted historical content pin. */
  registration: MeterRegistrationSnapshot;
  replay: MeteringReplayStore;
  maxReceiptAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
}

export interface MeteredJobVoteResult extends MeteredApproval {
  transactionHash: Hex;
}

/**
 * Submit an APPROVE vote only after:
 * 1. Reading the live submitted job and accepted validator committee state;
 * 2. Authenticated historical provider meter registration;
 * 3. Independent result acceptance, signed receipt binding and replay reservation.
 *
 * A failed transaction deliberately leaves the durable replay reservation in place.
 * Operator reconciliation must inspect the chain before attempting another vote.
 * Existing non-metered watcher behavior remains unchanged.
 */
export async function voteMeteredJob(input: MeteredJobVoteInput): Promise<MeteredJobVoteResult> {
  const me = input.wallet.account.address;
  const job = await readJob(input.client, input.evaluator, input.jobId, me);

  if (
    job.status !== JobStatus.Submitted ||
    job.phase !== Phase.Configured ||
    job.memberState !== MemberState.Accepted ||
    job.deliverable === null
  ) {
    throw new MeteringReceiptError(
      "JOB_NOT_VOTABLE",
      "metered job must be submitted with a validator that has accepted",
    );
  }
  if (
    input.registration.jobId !== input.jobId ||
    input.registration.chainId !== (await input.client.getChainId()) ||
    input.registration.evaluatorAddress.toLowerCase() !== input.evaluator.toLowerCase()
  ) {
    throw new MeteringReceiptError(
      "REGISTRATION_UNAVAILABLE",
      "historical registration is not for the live job",
    );
  }

  // Never use a self-claimed signer from the receipt, or an unpinned HTTPS file.
  const { expectedSigner } = await resolveMeterSigner(input.client, input.registration);
  const context = {
    chainId: input.registration.chainId,
    evaluatorAddress: input.evaluator,
    jobId: input.jobId.toString(),
    specHash: job.specHash,
    deliverableHash: job.deliverable,
    containerDigest: input.spec.container_digest,
    expectedSigner,
    ...(input.maxReceiptAgeSeconds === undefined
      ? {}
      : {
          nowSeconds: Math.floor(Date.now() / 1000),
          maxReceiptAgeSeconds: input.maxReceiptAgeSeconds,
          maxFutureSkewSeconds: input.maxFutureSkewSeconds ?? 5,
        }),
  };
  const approval = await buildMeteredApproval({
    spec: input.spec,
    result: input.result,
    receipt: input.receipt,
    context,
    replay: input.replay,
  });

  // The existing ABI accepts an evidence bytes32. This is the composite hash;
  // it is not the EIP-712 digest, the receipt hash, or a billable quantity.
  const transactionHash = await castVote(
    input.wallet,
    input.client,
    input.evaluator,
    input.jobId,
    true,
    job.deliverable,
    approval.evidenceHash,
  );
  return { ...approval, transactionHash };
}
