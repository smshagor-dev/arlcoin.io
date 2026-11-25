// Provisional ERC-8004 metering-key registration resolver for arl-metering-receipt/1.
//
// It independently checks the configured provider/agent/registry at one historical
// on-chain block, then verifies the full registration document against an externally
// authenticated SHA-256 pin. HTTPS alone does not authenticate mutable metadata.
// The extension namespace and snapshot policy still require upstream approval.

import { createHash } from "node:crypto";

import { parseAbi, type Address, type Hex, type PublicClient } from "viem";

import { evaluatorAbi, jobsAbi } from "../chain.ts";
import {
  MeteringReceiptError,
  parseMeteringJson,
  verifyMeteringReceipt,
  type MeteringVerificationContext,
  type SignedMeteringReceipt,
  type VerifiedMeteringReceipt,
} from "./receipt.ts";

const evaluatorIdentityAbi = parseAbi(["function identity() view returns (address)"]);
const identityAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
]);

const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
const EXTENSION = "arl-metering-receipt/1";
const MAX_REGISTRATION_BYTES = 64 * 1024;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

export interface MeterRegistrationSnapshot {
  chainId: number;
  evaluatorAddress: Address;
  jobId: bigint;
  /** Historical block selected by trusted job policy, never by the receipt itself. */
  registrationBlock: bigint;
  /** SHA-256 digest from a trusted, independent commitment to this registration version. */
  pinnedRegistrationSha256: Hex;
  /**
   * Untrusted document bytes delivered by a caller's bounded transport.
   * No arbitrary HTTP fetch or redirect handling occurs inside this resolver.
   */
  registrationBytes: Uint8Array;
  /** The exact externally authenticated URI for HTTPS/IPFS metadata. */
  expectedRegistrationUri?: string;
}

export interface ResolvedMeterRegistration {
  expectedSigner: Address;
  provider: Address;
  agentId: bigint;
  registry: Address;
  registrationUri: string;
  registrationBlock: bigint;
}

function registrationError(reason: string): never {
  throw new MeteringReceiptError("REGISTRATION_UNAVAILABLE", reason);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return registrationError("registration document must be an object");
  }
  return value as Record<string, unknown>;
}

function validateSigner(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    return registrationError("registered meter signer must be an EVM address");
  }
  if (/^0x0{40}$/i.test(value)) return registrationError("zero meter signer is forbidden");
  return value.toLowerCase() as Address;
}

function validAgentId(value: unknown, expected: bigint): boolean {
  if (typeof value === "string") {
    return /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 78 &&
      BigInt(value) === expected;
  }
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    BigInt(value) === expected;
}

/**
 * Resolve the per-meter signer from a pinned historical on-chain identity
 * and an independently pinned registration snapshot. No claimed envelope
 * signer, current mutable metadata or HTTPS origin can substitute for the pin.
 */
export async function resolveMeterSigner(
  client: PublicClient,
  snapshot: MeterRegistrationSnapshot,
): Promise<ResolvedMeterRegistration> {
  if (
    !Number.isSafeInteger(snapshot.chainId) ||
    snapshot.chainId <= 0 ||
    !ADDRESS.test(snapshot.evaluatorAddress) ||
    snapshot.jobId < 0n ||
    snapshot.registrationBlock < 0n ||
    !HASH.test(snapshot.pinnedRegistrationSha256) ||
    !(snapshot.registrationBytes instanceof Uint8Array) ||
    snapshot.registrationBytes.byteLength > MAX_REGISTRATION_BYTES
  ) {
    return registrationError("invalid or unauthenticated registration snapshot configuration");
  }
  if ((await client.getChainId()) !== snapshot.chainId) {
    return registrationError("registration RPC is connected to the wrong chain");
  }

  const blockNumber = snapshot.registrationBlock;
  const evaluatorAddress = snapshot.evaluatorAddress;
  let identityRegistry: Address;
  let jobsAddress: Address;
  try {
    [identityRegistry, jobsAddress] = await Promise.all([
      client.readContract({
        address: evaluatorAddress,
        abi: evaluatorIdentityAbi,
        functionName: "identity",
        blockNumber,
      }),
      client.readContract({
        address: evaluatorAddress,
        abi: evaluatorAbi,
        functionName: "jobs",
        blockNumber,
      }),
    ]);
  } catch {
    return registrationError("could not authenticate evaluator's historical registry");
  }
  if (
    !ADDRESS.test(identityRegistry) ||
    /^0x0{40}$/i.test(identityRegistry) ||
    !ADDRESS.test(jobsAddress)
  ) {
    return registrationError("evaluator lacks an authenticated identity registry");
  }

  let agentId: bigint;
  let provider: Address;
  try {
    const [config, job] = await Promise.all([
      client.readContract({
        address: evaluatorAddress,
        abi: evaluatorAbi,
        functionName: "getConfig",
        args: [snapshot.jobId],
        blockNumber,
      }),
      client.readContract({
        address: jobsAddress,
        abi: jobsAbi,
        functionName: "getJob",
        args: [snapshot.jobId],
        blockNumber,
      }),
    ]);
    if (
      job.evaluator.toLowerCase() !== evaluatorAddress.toLowerCase() ||
      job.id !== snapshot.jobId ||
      !ADDRESS.test(job.provider) ||
      /^0x0{40}$/i.test(job.provider)
    ) {
      return registrationError("historical job has no bound provider/evaluator");
    }
    agentId = config.providerAgentId;
    provider = job.provider;
  } catch {
    return registrationError("cannot authenticate historical job and agent binding");
  }
  if (agentId === 0n) return registrationError("metered job has no provider agent id");

  let registrationUri: string;
  try {
    const [owner, uri] = await Promise.all([
      client.readContract({
        address: identityRegistry,
        abi: identityAbi,
        functionName: "ownerOf",
        args: [agentId],
        blockNumber,
      }),
      client.readContract({
        address: identityRegistry,
        abi: identityAbi,
        functionName: "tokenURI",
        args: [agentId],
        blockNumber,
      }),
    ]);
    if (owner.toLowerCase() !== provider.toLowerCase()) {
      return registrationError("registered agent owner does not match job provider");
    }
    registrationUri = uri;
  } catch {
    return registrationError("historical ERC-8004 agent registration cannot be verified");
  }
  if (!/^(https:\/\/|ipfs:\/\/|data:application\/json;)/.test(registrationUri)) {
    return registrationError("unsupported registration URI scheme");
  }

  const bytes = Buffer.from(snapshot.registrationBytes);
  const dataPrefix = "data:application/json;base64,";
  if (registrationUri.startsWith(dataPrefix)) {
    const encoded = registrationUri.slice(dataPrefix.length);
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.length > MAX_REGISTRATION_BYTES * 2 ||
      Buffer.from(encoded, "base64").toString("base64") !== encoded
    ) {
      return registrationError("on-chain registration data URI is not canonical base64");
    }
    if (!Buffer.from(encoded, "base64").equals(bytes)) {
      return registrationError("on-chain registration data URI and pinned bytes differ");
    }
  } else if (snapshot.expectedRegistrationUri !== registrationUri) {
    return registrationError("external metadata URI does not match the pinned source");
  }

  const digest = "0x" + createHash("sha256").update(bytes).digest("hex");
  if (digest !== snapshot.pinnedRegistrationSha256) {
    return registrationError("registration metadata bytes differ from trusted snapshot pin");
  }

  let raw: Record<string, unknown>;
  try {
    raw = object(parseMeteringJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return registrationError("registration document is not strict UTF-8 JSON");
  }
  if (raw.type !== REGISTRATION_TYPE) {
    return registrationError("incorrect ERC-8004 registration document type");
  }
  if (!Array.isArray(raw.registrations)) {
    return registrationError("registration file has no identity cross-reference");
  }
  const agentRegistry = `eip155:${snapshot.chainId}:${identityRegistry.toLowerCase()}`;
  const matches = raw.registrations.some((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.agentRegistry === "string" &&
      item.agentRegistry.toLowerCase() === agentRegistry &&
      validAgentId(item.agentId, agentId);
  });
  if (!matches) return registrationError("registration file points to a different agent");

  const extension = object(object(raw.extensions)[EXTENSION]);
  const expectedSigner = validateSigner(extension.signer);

  return {
    expectedSigner,
    provider,
    agentId,
    registry: identityRegistry,
    registrationUri,
    registrationBlock: blockNumber,
  };
}

/** Resolver-enforced receipt verification; callers cannot supply their own signer. */
export async function verifyRegisteredMeteringReceipt(
  client: PublicClient,
  signed: SignedMeteringReceipt,
  context: Omit<MeteringVerificationContext, "expectedSigner">,
  registration: MeterRegistrationSnapshot,
): Promise<VerifiedMeteringReceipt> {
  if (
    registration.chainId !== context.chainId ||
    registration.evaluatorAddress.toLowerCase() !== context.evaluatorAddress.toLowerCase() ||
    registration.jobId.toString() !== context.jobId
  ) {
    return registrationError("registration context does not match the intended job");
  }
  const { expectedSigner } = await resolveMeterSigner(client, registration);
  return verifyMeteringReceipt(signed, { ...context, expectedSigner });
}
