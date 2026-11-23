// Trusted provider-only reference: one real cgroup-metered re-execution,
// one provider EIP-712 signature, and one complete local receipt artifact.
// Never pass a validator wallet/private key as the provider's meter key.

import type { Fetcher } from "../inputs.ts";
import { execute, type Execution } from "../verify.ts";
import type { ReexecSpec } from "../spec.ts";
import {
  publishSignedMeteringArtifact,
  type PublishedMeteringArtifact,
} from "./artifact.ts";
import { MeteredDockerRunner } from "./runner.ts";
import {
  produceMeteringReceipt,
  type MeteringProducerIdentity,
} from "./produce.ts";
import type { SignedMeteringReceipt } from "./receipt.ts";

export interface MeteredProviderOptions {
  /** Trusted Linux cgroup v2 subtree, provisioned by the host operator. */
  cgroupRoot: string;
  /** Exact, absolute destination of the signed receipt; must not already exist. */
  receiptPath: string;
  fetcher: Fetcher;
  maxDiskBytes?: number;
  tmpRoot?: string;
  signal?: AbortSignal;
}

export interface MeteredProviderResult {
  execution: Execution;
  signed: SignedMeteringReceipt;
  publication: PublishedMeteringArtifact;
}

/**
 * Full provider execution path, using the actual MeteredDockerRunner rather
 * than accepting caller-provided measurements or a mocked ContainerRunner.
 *
 * Failed container executions, failed signature checks, and failed atomic
 * publication never return a successful receipt reference. Artifact content
 * hashes are not authorization: the validator obtains their trusted pin
 * and historical meter-key registration independently.
 */
export async function executeAndPublishMeteredReceipt(
  spec: ReexecSpec,
  identity: MeteringProducerIdentity,
  opts: MeteredProviderOptions,
): Promise<MeteredProviderResult> {
  const runner = new MeteredDockerRunner({
    cgroupRoot: opts.cgroupRoot,
    ...(opts.maxDiskBytes === undefined ? {} : { maxDiskBytes: opts.maxDiskBytes }),
  });
  const execution = await execute(spec, {
    runner,
    fetcher: opts.fetcher,
    ...(opts.tmpRoot === undefined ? {} : { tmpRoot: opts.tmpRoot }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  opts.signal?.throwIfAborted();
  const signed = await produceMeteringReceipt(spec, execution, identity);
  opts.signal?.throwIfAborted();
  const publication = await publishSignedMeteringArtifact(opts.receiptPath, signed);
  return { execution, signed, publication };
}
