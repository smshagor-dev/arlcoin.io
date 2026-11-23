import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CanonicalError, canonicalHash } from "../src/canonical.ts";

interface Receipt {
  version: string;
  chain_id: number;
  evaluator_address: Address;
  job_id: string;
  spec_hash: Hex;
  deliverable_hash: Hex;
  run_id: Hex;
  nonce: Hex;
  [key: string]: unknown;
}

interface Mutation {
  name: string;
  changes: Record<string, unknown>;
  expected_error: string;
  expected_receipt_hash: Hex | null;
}

interface Vectors {
  valid: {
    receipt: Receipt;
    expected_signer: Address;
    receipt_hash: Hex;
    typed_data_digest: Hex;
    signature: Hex;
    composite: { version: string; result_hash: Hex; receipt_hash: Hex };
    composite_evidence_hash: Hex;
  };
  invalid_mutations: Mutation[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../spec/arl-metering-receipt/v0.1.0/vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

const receipt = vectors.valid.receipt;
const types = {
  MeteringReceipt: [
    { name: "receiptHash", type: "bytes32" },
    { name: "jobId", type: "uint256" },
    { name: "specHash", type: "bytes32" },
    { name: "deliverableHash", type: "bytes32" },
    { name: "runId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const CURVE_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

function typedData(r: Receipt) {
  return {
    domain: {
      name: "ARL Verifiable Resource Metering",
      version: "1",
      chainId: r.chain_id,
      verifyingContract: r.evaluator_address,
    },
    types,
    primaryType: "MeteringReceipt" as const,
    message: {
      receiptHash: canonicalHash(r),
      jobId: BigInt(r.job_id),
      specHash: r.spec_hash,
      deliverableHash: r.deliverable_hash,
      runId: r.run_id,
      nonce: r.nonce,
    },
  };
}

function change(r: Receipt, patch: Record<string, unknown>): Receipt {
  const updated = { ...r } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === "__DELETE__") delete updated[key];
    else updated[key] = value;
  }
  return updated as Receipt;
}

async function recoversExpectedSigner(r: Receipt, signature = vectors.valid.signature) {
  try {
    const actual = await recoverTypedDataAddress({ ...typedData(r), signature });
    return actual.toLowerCase() === vectors.valid.expected_signer.toLowerCase();
  } catch {
    return false;
  }
}

describe("arl-metering-receipt/1 specification vectors", () => {
  it("pins canonical receipt and composite vote commitments", () => {
    assert.equal(canonicalHash(receipt), vectors.valid.receipt_hash);
    assert.equal(vectors.valid.composite.receipt_hash, vectors.valid.receipt_hash);
    assert.equal(vectors.valid.composite.result_hash, receipt.deliverable_hash);
    assert.equal(canonicalHash(vectors.valid.composite), vectors.valid.composite_evidence_hash);
  });

  it("cross-checks the external EIP-712 digest and signer with viem", async () => {
    const data = typedData(receipt);
    assert.equal(hashTypedData(data), vectors.valid.typed_data_digest);

    const key = keccak256(stringToBytes("arl-metering-test-vector-only-not-private"));
    const account = privateKeyToAccount(key);
    assert.equal(account.address.toLowerCase(), vectors.valid.expected_signer.toLowerCase());

    // secp256k1 signing need not serialize byte-for-byte identically across libraries.
    // Both the independently generated fixture and a fresh viem signature must verify.
    assert.equal(await recoversExpectedSigner(receipt), true);
    const viemSignature = await account.signTypedData(data);
    assert.equal(await recoversExpectedSigner(receipt, viemSignature), true);

    const s = BigInt("0x" + vectors.valid.signature.slice(66, 130));
    assert.ok(s > 0n && s <= CURVE_ORDER / 2n, "fixture signature must be low-S");
    assert.equal(vectors.valid.signature.length, 132, "recoverable signature must be 65 bytes");
  });

  it("pins every mutation hash and refuses unsafe integer canonicalization", () => {
    for (const mutation of vectors.invalid_mutations) {
      const mutated = change(receipt, mutation.changes);
      if (mutation.expected_receipt_hash === null) {
        assert.throws(() => canonicalHash(mutated), CanonicalError, mutation.name);
      } else {
        assert.equal(canonicalHash(mutated), mutation.expected_receipt_hash, mutation.name);
      }
    }
  });

  it("rejects tampered measurement and changed signed job bindings", async () => {
    for (const name of [
      "cpu-tampered",
      "memory-tampered",
      "wrong-chain",
      "wrong-evaluator",
      "wrong-job",
      "wrong-spec",
      "wrong-deliverable",
      "nonce-changed",
    ]) {
      const mutation = vectors.invalid_mutations.find((entry) => entry.name === name);
      assert.ok(mutation, "missing fixture " + name);
      const mutated = change(receipt, mutation.changes);
      assert.notEqual(hashTypedData(typedData(mutated)), vectors.valid.typed_data_digest, name);
      assert.equal(await recoversExpectedSigner(mutated), false, name);
    }
  });

  it("rejects signatures from unauthorized signers even for an unchanged receipt", async () => {
    const unauthorized = privateKeyToAccount(
      keccak256(stringToBytes("arl-metering-different-public-test-key")),
    );
    const signature = await unauthorized.signTypedData(typedData(receipt));
    assert.equal(await recoversExpectedSigner(receipt, signature), false);
  });

  it("detects altered signature data rather than trusting an envelope signer", async () => {
    const invalid = ("0x" + "00".repeat(65)) as Hex;
    assert.equal(await recoversExpectedSigner(receipt, invalid), false);
  });

  it("demonstrates why schema validation must precede canonical hashing", () => {
    const missing = change(receipt, { memory_peak_bytes: "__DELETE__" });
    const extra = change(receipt, { unrecognized_key: "never silently accept" });
    assert.notEqual(canonicalHash(missing), canonicalHash(receipt));
    assert.notEqual(canonicalHash(extra), canonicalHash(receipt));
    // canonicalize() does not enforce receipt fields: the later verifier must.
    assert.equal(canonicalHash({ ...receipt, absent: undefined }), canonicalHash(receipt));
  });
});
