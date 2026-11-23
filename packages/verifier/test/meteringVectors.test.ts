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

describe("arl-metering-receipt/1 specification vectors", () => {
  it("pins the existing canonical JSON hash and the composite evidence hash", () => {
    assert.equal(canonicalHash(receipt), vectors.valid.receipt_hash);
    assert.equal(vectors.valid.composite.receipt_hash, vectors.valid.receipt_hash);
    assert.equal(vectors.valid.composite.result_hash, receipt.deliverable_hash);
    assert.equal(canonicalHash(vectors.valid.composite), vectors.valid.composite_evidence_hash);
  });

  it("pins an independently computed EIP-712 digest and recoverable signature", async () => {
    const data = typedData(receipt);
    assert.equal(hashTypedData(data), vectors.valid.typed_data_digest);
    const key = keccak256(stringToBytes("arl-metering-test-vector-only-not-private"));
    const account = privateKeyToAccount(key);
    assert.equal(account.address.toLowerCase(), vectors.valid.expected_signer.toLowerCase());
    assert.equal(await account.signTypedData(data), vectors.valid.signature);
    const recovered = await recoverTypedDataAddress({
      ...data,
      signature: vectors.valid.signature,
    });
    assert.equal(recovered.toLowerCase(), vectors.valid.expected_signer.toLowerCase());
  });

  it("pins malformed and tampered receipt canonical hashes where defined", () => {
    for (const mutation of vectors.invalid_mutations) {
      const mutated = change(receipt, mutation.changes);
      if (mutation.expected_receipt_hash === null) {
        assert.throws(() => canonicalHash(mutated), CanonicalError, mutation.name);
      } else {
        assert.equal(canonicalHash(mutated), mutation.expected_receipt_hash, mutation.name);
      }
    }
  });

  it("shows that a measurement change invalidates the signed typed-data commitment", async () => {
    const tampered = change(receipt, { cpu_time_ns: 1_120_000_001 });
    const digest = hashTypedData(typedData(tampered));
    assert.notEqual(digest, vectors.valid.typed_data_digest);
    const recovered = await recoverTypedDataAddress({
      ...typedData(tampered),
      signature: vectors.valid.signature,
    });
    assert.notEqual(recovered.toLowerCase(), vectors.valid.expected_signer.toLowerCase());
  });

  it("documents schema and replay rejection cases for the later independent verifier", () => {
    const errors = new Map(vectors.invalid_mutations.map((m) => [m.name, m.expected_error]));
    for (const name of [
      "negative-cpu",
      "unsafe-cpu",
      "gpu-zero",
      "missing-memory",
      "timestamp-reversed",
      "wrong-chain",
      "wrong-evaluator",
      "wrong-job",
      "wrong-spec",
      "wrong-deliverable",
      "unexpected-signer",
      "invalid-signature",
      "duplicate-replay",
      "composite-mismatch",
    ]) {
      assert.ok(errors.has(name), `missing scenario: ${name}`);
    }
  });
});