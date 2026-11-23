// Opt-in, fail-closed metered vote. The production watcher is unchanged.
// An authenticated provider meter receipt is bound to the validator's own re-execution.

import type { Hex, PublicClient } from "viem";

import { castVote, JobStatus, MemberState, Phase, readJob } from "../chain.ts";
import type { ResultManifest } from "../result.ts";
import { specHash, type ReexecSpec } from "../spec.ts";
import { execute, type ExecuteOptions, type Execution } from "../verify.ts";
import { buildMeteredApproval, type MeteredApproval } from "./evidence.ts";
import {
  MeteringReceiptError,
  verifyMeteringReceipt,
  type MeteringVerificationContext,
  type SignedMeteringReceipt,
} from "./receipt.ts";
import { resolveMeterSigner, type MeterRegistrationSnapshot } from "./registration.ts";
import type { MeteringReplayStore } from "./replay.ts";

type ValidatorWallet = Parameters<typeof castVote>[0];
type Evaluator = Parameters<typeof castVote>[2];

export interface MeteredJobVoteInput {
  client: PublicClient;
  wallet: ValidatorWallet;
  evaluator: Evaluator;
  jobId: bigint;
  /** The validator's own re-execution result, never a provider result. */
  result: ResultManifest;
  spec: ReexecSpec;
  receipt: SignedMeteringReceipt;
  registration: MeterRegistrationSnapshot;
  replay: MeteringReplayStore;
  /** Mandatory freshness bound, in seconds. */
  maxReceiptAgeSeconds: number;
  maxFutureSkewSeconds?: number;
}

export interface MeteredJobVoteResult extends MeteredApproval {
  transactionHash: Hex;
}

export interface ExecuteAndVoteMeteredJobInput extends Omit<MeteredJobVoteInput, "result"> {
  /** A real validator must configure an isolated trusted ContainerRunner. */
  execution: ExecuteOptions;
}

export interface ExecutedMeteredJobVote extends MeteredJobVoteResult {
  execution: Execution;
}

type PreflightInput = Omit<MeteredJobVoteInput, "result" | "replay">;

/**
 * Reject an invalid job, wrong committed spec, expired or forged meter receipt before
 * spending resources on the validator's own re-execution or reserving replay state.
 *
 * The registration snapshot's authority remains a separate upstream protocol decision:
 * do not treat an untrusted caller-selected snapshot SHA-256 as an authorization.
 */
async function preflightMeteredJob(input: PreflightInput): Promise<{
  deliverable: Hex;
  context: MeteringVerificationContext;
}> {
  if (
    !Number.isSafeInteger(input.maxReceiptAgeSeconds) ||
    input.maxReceiptAgeSeconds <= 0
  ) {
    throw new MeteringReceiptError(
      "INVALID_TIMESTAMP",
      "a positive explicit receipt freshness window is mandatory",
    );
  }

  const job = await readJob(
    input.client,
    input.evaluator,
    input.jobId,
    input.wallet.account.address,
  );
  if (
    job.status !== JobStatus.Submitted ||
    job.phase !== Phase.Configured ||
    job.memberState !== MemberState.Accepted ||
    job.deliverable === null
  ) {
    throw new MeteringReceiptError(
      "JOB_NOT_VOTABLE",
      "metered job must be submitted and validator must have accepted",
    );
  }
  const { timestamp: chainTimestamp } = await input.client.getBlock();
  if (
    chainTimestamp >= job.expiredAt ||
    (job.voteEnds !== 0n && chainTimestamp >= job.voteEnds)
  ) {
    throw new MeteringReceiptError(
      "JOB_NOT_VOTABLE",
      "job deadline or validator vote window has passed",
    );
  }
  const committed = specHash(input.spec);
  if (committed !== job.specHash) {
    throw new MeteringReceiptError("SPEC_MISMATCH", "spec differs from the on-chain commitment");
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

  const { expectedSigner } = await resolveMeterSigner(input.client, input.registration);
  // A provider cannot authorize a measurement by registering a key AFTER the
  // reported run began. The chain block timestamp is independent of host wall
  // time, although second-level timestamps cannot prove within-second order.
  let registrationTimestamp: bigint;
  try {
    const block = await input.client.getBlock({
      blockNumber: input.registration.registrationBlock,
    });
    registrationTimestamp = block.timestamp;
  } catch {
    throw new MeteringReceiptError(
      "REGISTRATION_UNAVAILABLE",
      "cannot determine the timestamp of the trusted registration snapshot",
    );
  }
  if (registrationTimestamp > BigInt(input.receipt.receipt.started_at)) {
    throw new MeteringReceiptError(
      "REGISTRATION_UNAVAILABLE",
      "provider meter key was registered after the claimed workload started",
    );
  }
  const context: MeteringVerificationContext = {
    chainId: input.registration.chainId,
    evaluatorAddress: input.evaluator,
    jobId: input.jobId.toString(),
    specHash: job.specHash,
    deliverableHash: job.deliverable,
    containerDigest: input.spec.container_digest,
    expectedSigner,
    // The host observes Docker start/wait overhead, but the measured CPU time
    // must still be bounded by the configured core count and time limit.
    maxElapsedNs: (input.spec.limits.seconds + 30) * 1_000_000_000,
    maxCpuTimeNs: (input.spec.limits.seconds + 30) * input.spec.limits.cpus * 1_000_000_000,
    maxMemoryBytes: input.spec.limits.memory_mb * 1024 * 1024 + 32 * 1024 * 1024,
    nowSeconds: Math.floor(Date.now() / 1000),
    maxReceiptAgeSeconds: input.maxReceiptAgeSeconds,
    maxFutureSkewSeconds: input.maxFutureSkewSeconds ?? 5,
  };
  await verifyMeteringReceipt(input.receipt, context);
  return { deliverable: job.deliverable, context };
}

/**
 * Casts the existing vote ABI with the authenticated composite evidence hash.
 * An unsuccessful transaction deliberately leaves a fail-closed replay marker
 * that requires inspection of chain state before any operator reconciliation.
 */
export async function voteMeteredJob(input: MeteredJobVoteInput): Promise<MeteredJobVoteResult> {
  const { context, deliverable } = await preflightMeteredJob(input);
  const approval = await buildMeteredApproval({
    spec: input.spec,
    result: input.result,
    receipt: input.receipt,
    context,
    replay: input.replay,
  });
  const transactionHash = await castVote(
    input.wallet,
    input.client,
    input.evaluator,
    input.jobId,
    true,
    deliverable,
    approval.evidenceHash,
  );
  return { ...approval, transactionHash };
}

/**
 * Full optional validator entrypoint: authenticate the job and signed receipt first,
 * independently execute its pinned spec, then recheck on-chain eligibility before voting.
 *
 * Existing default watch/step behavior is left untouched. A metered receipt does not
 * turn a synthetic or untrusted runner into physical resource attestation.
 */
export async function executeAndVoteMeteredJob(
  input: ExecuteAndVoteMeteredJobInput,
): Promise<ExecutedMeteredJobVote> {
  const { execution: executionOptions, ...voteInput } = input;
  await preflightMeteredJob(voteInput);
  const executed = await execute(voteInput.spec, executionOptions);
  executionOptions.signal?.throwIfAborted();
  const vote = await voteMeteredJob({ ...voteInput, result: executed.result });
  return { ...vote, execution: executed };
}
