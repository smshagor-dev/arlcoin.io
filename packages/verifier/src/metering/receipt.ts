// arl-metering-receipt/1. This module validates claims and signatures, not physical resource use.
// The authorized meter address MUST come from a separate authenticated registration resolver.

import {
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { canonicalHash } from "../canonical.ts";

export const METERING_RECEIPT_VERSION = "arl-metering-receipt/1";
export const METERING_TRUST_LEVEL = "trusted-host/software";
export const METERING_SOURCE = "linux-cgroup-v2";

export interface MeteringReceipt {
  version: typeof METERING_RECEIPT_VERSION;
  chain_id: number;
  evaluator_address: Address;
  job_id: string;
  spec_hash: Hex;
  deliverable_hash: Hex;
  run_id: Hex;
  nonce: Hex;
  container_digest: string;
  meter_version: string;
  meter_source: typeof METERING_SOURCE;
  trust_level: typeof METERING_TRUST_LEVEL;
  started_at: number;
  finished_at: number;
  elapsed_ns: number;
  cpu_time_ns: number;
  memory_peak_bytes: number;
  gpu_metrics: null;
}

export interface SignedMeteringReceipt {
  receipt: MeteringReceipt;
  signature: Hex;
}

export interface MeteringVerificationContext {
  chainId: number;
  evaluatorAddress: Address;
  jobId: string;
  specHash: Hex;
  deliverableHash: Hex;
  containerDigest: string;
  /** Independently resolved from authenticated provider registration, never from the receipt. */
  expectedSigner: Address;
  maxElapsedNs?: number;
  maxCpuTimeNs?: number;
  maxMemoryBytes?: number;
  /** Optional verification-time freshness policy. Omit only for explicit historical audits. */
  nowSeconds?: number;
  maxReceiptAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
}

export interface VerifiedMeteringReceipt {
  receipt: MeteringReceipt;
  receiptHash: Hex;
  signer: Address;
}

export class MeteringReceiptError extends Error {
  override name = "MeteringReceiptError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const KEYS = [
  "version",
  "chain_id",
  "evaluator_address",
  "job_id",
  "spec_hash",
  "deliverable_hash",
  "run_id",
  "nonce",
  "container_digest",
  "meter_version",
  "meter_source",
  "trust_level",
  "started_at",
  "finished_at",
  "elapsed_ns",
  "cpu_time_ns",
  "memory_peak_bytes",
  "gpu_metrics",
] as const;

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const IMAGE = /^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;
const METER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/;
const JOB_ID = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const CURVE_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

function fail(code: string, message: string): never {
  throw new MeteringReceiptError(code, message);
}

function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("MALFORMED_RECEIPT", "receipt must be an object");
  }
  const proto = Object.getPrototypeOf(raw) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return fail("MALFORMED_RECEIPT", "receipt must be a plain object");
  }
  return raw as Record<string, unknown>;
}

function exactKeys(raw: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Object.hasOwn(raw, key)) fail("MISSING_FIELD", "missing required field: " + key);
  }
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) fail("MALFORMED_RECEIPT", "unknown field: " + key);
  }
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail("UNSAFE_INTEGER", field + " must be a safe JSON integer");
  }
  if (value < minimum || Object.is(value, -0)) {
    return fail("INVALID_MEASUREMENT", field + " must be nonnegative and in range");
  }
  return value;
}

function hex32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) {
    return fail("MALFORMED_RECEIPT", field + " must be lowercase bytes32");
  }
  return value as Hex;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    return fail("MALFORMED_RECEIPT", field + " must be a lowercase EVM address");
  }
  return value as Address;
}

function jobId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !JOB_ID.test(value) ||
    BigInt(value) > UINT256_MAX
  ) {
    return fail("MALFORMED_RECEIPT", "job_id must be a canonical uint256 decimal string");
  }
  return value;
}

/**
 * Parse exact receipt fields BEFORE canonicalHash: canonicalize omits undefined object
 * members and, by design, does not enforce receipt-specific schema requirements.
 */
export function parseMeteringReceipt(raw: unknown): MeteringReceipt {
  const r = record(raw);
  exactKeys(r, KEYS);

  if (r.version !== METERING_RECEIPT_VERSION) {
    fail("UNSUPPORTED_VERSION", "unsupported metering receipt version");
  }
  const chain_id = integer(r.chain_id, "chain_id", 1);
  const evaluator_address = address(r.evaluator_address, "evaluator_address");
  const job_id = jobId(r.job_id);
  const spec_hash = hex32(r.spec_hash, "spec_hash");
  const deliverable_hash = hex32(r.deliverable_hash, "deliverable_hash");
  const run_id = hex32(r.run_id, "run_id");
  const nonce = hex32(r.nonce, "nonce");

  if (typeof r.container_digest !== "string" || !IMAGE.test(r.container_digest)) {
    fail("MALFORMED_RECEIPT", "container_digest must be a pinned image digest");
  }
  if (typeof r.meter_version !== "string" || !METER_VERSION.test(r.meter_version)) {
    fail("MALFORMED_RECEIPT", "invalid meter_version");
  }
  if (r.meter_source !== METERING_SOURCE) {
    fail("UNSUPPORTED_METER_SOURCE", "meter_source must be linux-cgroup-v2");
  }
  if (r.trust_level !== METERING_TRUST_LEVEL) {
    fail("MALFORMED_RECEIPT", "unsupported trust_level");
  }
  if (r.gpu_metrics !== null) {
    fail("INVALID_GPU_METRICS", "unsupported GPU metrics must be null");
  }

  const started_at = integer(r.started_at, "started_at");
  const finished_at = integer(r.finished_at, "finished_at");
  const elapsed_ns = integer(r.elapsed_ns, "elapsed_ns");
  const cpu_time_ns = integer(r.cpu_time_ns, "cpu_time_ns");
  const memory_peak_bytes = integer(r.memory_peak_bytes, "memory_peak_bytes");

  if (finished_at < started_at) fail("INVALID_TIMESTAMP", "finish precedes start");
  const wallNs = BigInt(finished_at - started_at) * 1_000_000_000n;
  const difference = wallNs - BigInt(elapsed_ns);
  if (difference <= -2_000_000_000n || difference >= 2_000_000_000n) {
    fail("INVALID_TIMESTAMP", "monotonic elapsed time and timestamps disagree");
  }

  return {
    version: METERING_RECEIPT_VERSION,
    chain_id,
    evaluator_address,
    job_id,
    spec_hash,
    deliverable_hash,
    run_id,
    nonce,
    container_digest: r.container_digest,
    meter_version: r.meter_version,
    meter_source: METERING_SOURCE,
    trust_level: METERING_TRUST_LEVEL,
    started_at,
    finished_at,
    elapsed_ns,
    cpu_time_ns,
    memory_peak_bytes,
    gpu_metrics: null,
  };
}

/**
 * Strict JSON syntax validation including duplicate keys at any nesting level.
 * Standard JSON.parse alone silently overwrites repeated object keys.
 */
export function parseMeteringJson(json: string): unknown {
  if (Buffer.byteLength(json, "utf8") > 65_536) {
    return fail("MALFORMED_RECEIPT", "JSON artifact exceeds 64 KiB");
  }

  let at = 0;
  function spaces(): void {
    while (at < json.length && /[\t\n\r ]/.test(json[at] ?? "")) at++;
  }
  function quoted(): string {
    const start = at++;
    let escaped = false;
    while (at < json.length) {
      const char = json[at++] ?? "";
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        try {
          return JSON.parse(json.slice(start, at)) as string;
        } catch {
          return fail("MALFORMED_RECEIPT", "invalid JSON string");
        }
      }
    }
    return fail("MALFORMED_RECEIPT", "unterminated JSON string");
  }
  function value(depth: number): void {
    if (depth > 32) fail("MALFORMED_RECEIPT", "JSON nesting too deep");
    spaces();
    const char = json[at];
    if (char === "{") {
      at++;
      spaces();
      const keys = new Set<string>();
      if (json[at] === "}") {
        at++;
        return;
      }
      while (at < json.length) {
        if (json[at] !== '"') fail("MALFORMED_RECEIPT", "expected JSON object key");
        const key = quoted();
        if (keys.has(key)) fail("MALFORMED_RECEIPT", "duplicate JSON key: " + key);
        keys.add(key);
        spaces();
        if (json[at++] !== ":") fail("MALFORMED_RECEIPT", "expected colon");
        value(depth + 1);
        spaces();
        const separator = json[at++];
        if (separator === "}") return;
        if (separator !== ",") fail("MALFORMED_RECEIPT", "expected comma or close brace");
        spaces();
      }
      fail("MALFORMED_RECEIPT", "unterminated JSON object");
    }
    if (char === "[") {
      at++;
      spaces();
      if (json[at] === "]") {
        at++;
        return;
      }
      while (at < json.length) {
        value(depth + 1);
        spaces();
        const separator = json[at++];
        if (separator === "]") return;
        if (separator !== ",") fail("MALFORMED_RECEIPT", "expected comma or close bracket");
      }
      fail("MALFORMED_RECEIPT", "unterminated JSON array");
    }
    if (char === '"') {
      quoted();
      return;
    }
    const start = at;
    while (at < json.length && !/[\t\n\r ,}\]]/.test(json[at] ?? "")) at++;
    if (at === start) fail("MALFORMED_RECEIPT", "expected JSON value");
    try {
      JSON.parse(json.slice(start, at));
    } catch {
      fail("MALFORMED_RECEIPT", "invalid JSON primitive");
    }
  }

  try {
    value(0);
    spaces();
    if (at !== json.length) fail("MALFORMED_RECEIPT", "unexpected trailing JSON");
    return JSON.parse(json) as unknown;
  } catch (error) {
    if (error instanceof MeteringReceiptError) throw error;
    return fail("MALFORMED_RECEIPT", "invalid JSON artifact");
  }
}

export function meteringReceiptHash(receipt: MeteringReceipt): Hex {
  return canonicalHash(parseMeteringReceipt(receipt));
}

const METERING_TYPES = {
  MeteringReceipt: [
    { name: "receiptHash", type: "bytes32" },
    { name: "jobId", type: "uint256" },
    { name: "specHash", type: "bytes32" },
    { name: "deliverableHash", type: "bytes32" },
    { name: "runId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function meteringTypedData(raw: MeteringReceipt) {
  const receipt = parseMeteringReceipt(raw);
  return {
    domain: {
      name: "ARL Verifiable Resource Metering",
      version: "1",
      chainId: receipt.chain_id,
      verifyingContract: receipt.evaluator_address,
    },
    primaryType: "MeteringReceipt" as const,
    types: METERING_TYPES,
    message: {
      receiptHash: meteringReceiptHash(receipt),
      jobId: BigInt(receipt.job_id),
      specHash: receipt.spec_hash,
      deliverableHash: receipt.deliverable_hash,
      runId: receipt.run_id,
      nonce: receipt.nonce,
    },
  };
}

function signature(raw: unknown): Hex {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(raw)) {
    return fail("SIGNATURE_INVALID", "signature must be 65-byte recoverable ECDSA");
  }
  const r = BigInt("0x" + raw.slice(2, 66));
  const s = BigInt("0x" + raw.slice(66, 130));
  const v = Number.parseInt(raw.slice(130, 132), 16);
  if (r === 0n || r >= CURVE_N || s === 0n || s > CURVE_N / 2n || (v !== 27 && v !== 28)) {
    return fail("SIGNATURE_INVALID", "signature must have canonical low-S and valid recovery");
  }
  return raw as Hex;
}

export function parseSignedMeteringReceipt(raw: unknown): SignedMeteringReceipt {
  const envelope = record(raw);
  exactKeys(envelope, ["receipt", "signature"]);
  return {
    receipt: parseMeteringReceipt(envelope.receipt),
    signature: signature(envelope.signature),
  };
}

export function parseSignedMeteringReceiptJson(json: string): SignedMeteringReceipt {
  return parseSignedMeteringReceipt(parseMeteringJson(json));
}

/** Signing is a producer-only action. Never expose the meter key to the validator. */
export async function signMeteringReceipt(
  raw: MeteringReceipt,
  meterPrivateKey: Hex,
): Promise<SignedMeteringReceipt> {
  const receipt = parseMeteringReceipt(raw);
  const account = privateKeyToAccount(meterPrivateKey);
  const signed = await account.signTypedData(meteringTypedData(receipt));
  return { receipt, signature: signature(signed) };
}

/**
 * Stateless authentication, identity binding and measurement validation.
 * The caller MUST supply expectedSigner from independent authenticated registration;
 * successful verification is NOT proof against a malicious host or a replayed receipt.
 */
export async function verifyMeteringReceipt(
  raw: SignedMeteringReceipt,
  context: MeteringVerificationContext,
): Promise<VerifiedMeteringReceipt> {
  const envelope = parseSignedMeteringReceipt(raw);
  const receipt = envelope.receipt;

  if (receipt.chain_id !== context.chainId) fail("CHAIN_MISMATCH", "wrong chain");
  if (receipt.evaluator_address.toLowerCase() !== context.evaluatorAddress.toLowerCase()) {
    fail("EVALUATOR_MISMATCH", "wrong evaluator");
  }
  if (receipt.job_id !== context.jobId) fail("JOB_MISMATCH", "wrong job");
  if (receipt.spec_hash !== context.specHash) fail("SPEC_MISMATCH", "wrong specification");
  if (receipt.deliverable_hash !== context.deliverableHash) {
    fail("DELIVERABLE_MISMATCH", "wrong deliverable");
  }
  if (receipt.container_digest !== context.containerDigest) {
    fail("CONTAINER_MISMATCH", "wrong pinned container");
  }
  if (context.maxElapsedNs !== undefined && receipt.elapsed_ns > context.maxElapsedNs) {
    fail("INVALID_MEASUREMENT", "elapsed duration exceeds configured limit");
  }
  if (
    context.maxCpuTimeNs !== undefined &&
    receipt.cpu_time_ns > context.maxCpuTimeNs
  ) {
    fail("INVALID_MEASUREMENT", "CPU time exceeds configured limit");
  }
  if (context.maxMemoryBytes !== undefined && receipt.memory_peak_bytes > context.maxMemoryBytes) {
    fail("INVALID_MEASUREMENT", "peak memory exceeds configured limit");
  }
  if (
    context.nowSeconds === undefined &&
    (context.maxReceiptAgeSeconds !== undefined ||
      context.maxFutureSkewSeconds !== undefined)
  ) {
    fail("INVALID_TIMESTAMP", "freshness limits require nowSeconds");
  }
  if (context.nowSeconds !== undefined) {
    const now = integer(context.nowSeconds, "nowSeconds");
    const skew = integer(context.maxFutureSkewSeconds ?? 0, "maxFutureSkewSeconds");
    if (
      BigInt(receipt.started_at) > BigInt(now) + BigInt(skew) ||
      BigInt(receipt.finished_at) > BigInt(now) + BigInt(skew)
    ) {
      fail("INVALID_TIMESTAMP", "metering receipt is in the future");
    }
    if (context.maxReceiptAgeSeconds !== undefined) {
      const maxAge = integer(context.maxReceiptAgeSeconds, "maxReceiptAgeSeconds");
      if (BigInt(now) - BigInt(receipt.finished_at) > BigInt(maxAge)) {
        fail("RECEIPT_EXPIRED", "metering receipt exceeds freshness window");
      }
    }
  }
  if (typeof context.expectedSigner !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(context.expectedSigner)) {
    fail("SIGNER_MISMATCH", "no authenticated meter signer");
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      ...meteringTypedData(receipt),
      signature: envelope.signature,
    });
  } catch {
    return fail("SIGNATURE_INVALID", "ECDSA signature recovery failed");
  }
  if (recovered.toLowerCase() !== context.expectedSigner.toLowerCase()) {
    fail("SIGNER_MISMATCH", "meter key is not authorized for this job");
  }
  return { receipt, receiptHash: meteringReceiptHash(receipt), signer: recovered };
}
