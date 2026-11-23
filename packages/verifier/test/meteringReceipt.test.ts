import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { keccak256, stringToBytes, type Hex } from "viem";

import {
  METERING_RECEIPT_VERSION,
  MeteringReceiptError,
  meteringReceiptHash,
  meteringTypedData,
  parseMeteringJson,
  parseMeteringReceipt,
  parseSignedMeteringReceipt,
  parseSignedMeteringReceiptJson,
  signMeteringReceipt,
  verifyMeteringReceipt,
  type MeteringReceipt,
  type MeteringVerificationContext,
} from "../src/metering/receipt.ts";

interface Vectors {
  valid: {
    receipt: MeteringReceipt;
    signature: Hex;
    receipt_hash: Hex;
    typed_data_digest: Hex;
    expected_signer: Hex;
  };
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../spec/arl-metering-receipt/v0.1.0/vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;
const receipt = vectors.valid.receipt;
const envelope = { receipt, signature: vectors.valid.signature };

const context: MeteringVerificationContext = {
  chainId: receipt.chain_id,
  evaluatorAddress: receipt.evaluator_address,
  jobId: receipt.job_id,
  specHash: receipt.spec_hash,
  deliverableHash: receipt.deliverable_hash,
  containerDigest: receipt.container_digest,
  expectedSigner: vectors.valid.expected_signer,
};

function changed(changes: Record<string, unknown>) {
  return { ...receipt, ...changes };
}

describe("metering receipt schema and EIP-712 verifier", () => {
  it("parses the committed fixture and independently verifies its authorized signature", async () => {
    assert.equal(parseMeteringReceipt(receipt).version, METERING_RECEIPT_VERSION);
    assert.equal(meteringReceiptHash(receipt), vectors.valid.receipt_hash);
    assert.equal(meteringTypedData(receipt).message.receiptHash, vectors.valid.receipt_hash);

    const verified = await verifyMeteringReceipt(envelope, context);
    assert.equal(verified.receiptHash, vectors.valid.receipt_hash);
    assert.equal(verified.signer.toLowerCase(), vectors.valid.expected_signer.toLowerCase());

    const key = keccak256(stringToBytes("arl-metering-test-vector-only-not-private"));
    const produced = await signMeteringReceipt(receipt, key);
    assert.equal((await verifyMeteringReceipt(produced, context)).receiptHash, verified.receiptHash);
  });

  it("rejects missing, unknown and type-invalid fields before hashing", () => {
    const { memory_peak_bytes: omitted, ...missing } = receipt;
    assert.equal(typeof omitted, "number");
    assert.throws(() => parseMeteringReceipt(missing), { code: "MISSING_FIELD" });
    assert.throws(() => parseMeteringReceipt(changed({ unexpected: 3 })), {
      code: "MALFORMED_RECEIPT",
    });
    assert.throws(() => parseMeteringReceipt(changed({ cpu_time_ns: "100" })), {
      code: "UNSAFE_INTEGER",
    });
    assert.throws(() => parseMeteringReceipt(changed({ cpu_time_ns: -1 })), {
      code: "INVALID_MEASUREMENT",
    });
    assert.throws(() => parseMeteringReceipt(changed({ cpu_time_ns: 2 ** 53 })), {
      code: "UNSAFE_INTEGER",
    });
    assert.throws(() => parseMeteringReceipt(changed({ gpu_metrics: 0 })), {
      code: "INVALID_GPU_METRICS",
    });
    assert.throws(() => parseMeteringReceipt(changed({ meter_source: "docker-stats" })), {
      code: "UNSUPPORTED_METER_SOURCE",
    });
  });

  it("rejects invalid addresses, identifiers and images without normalizing untrusted data", () => {
    assert.throws(() => parseMeteringReceipt(changed({ job_id: "07" })), {
      code: "MALFORMED_RECEIPT",
    });
    assert.throws(() => parseMeteringReceipt(changed({ job_id: "1".repeat(79) })), {
      code: "MALFORMED_RECEIPT",
    });
    assert.throws(() => parseMeteringReceipt(changed({ run_id: "0x" + "FF".repeat(32) })), {
      code: "MALFORMED_RECEIPT",
    });
    assert.throws(() => parseMeteringReceipt(changed({ evaluator_address: "bad-address" })), {
      code: "MALFORMED_RECEIPT",
    });
    assert.throws(() => parseMeteringReceipt(changed({ container_digest: "busybox:latest" })), {
      code: "MALFORMED_RECEIPT",
    });
  });

  it("rejects inconsistent timestamps and unbounded measurements", async () => {
    assert.throws(() => parseMeteringReceipt(changed({ finished_at: receipt.started_at - 1 })), {
      code: "INVALID_TIMESTAMP",
    });
    assert.throws(() => parseMeteringReceipt(changed({ elapsed_ns: 4_000_000_000 })), {
      code: "INVALID_TIMESTAMP",
    });
    await assert.rejects(
      () => verifyMeteringReceipt(envelope, { ...context, maxMemoryBytes: 1024 }),
      { code: "INVALID_MEASUREMENT" },
    );
    await assert.rejects(
      () => verifyMeteringReceipt(envelope, { ...context, maxElapsedNs: 1024 }),
      { code: "INVALID_MEASUREMENT" },
    );
  });

  it("detects duplicate JSON object keys at every depth including escape-equivalent keys", () => {
    const validJson = JSON.stringify(envelope);
    assert.equal(parseSignedMeteringReceiptJson(validJson).receipt.job_id, receipt.job_id);
    assert.equal(parseMeteringReceipt(parseMeteringJson(JSON.stringify(receipt))).job_id, "7");

    const duplicateTop = '{"receipt":{},"receipt":{},"signature":"0x00"}';
    assert.throws(() => parseMeteringJson(duplicateTop), { code: "MALFORMED_RECEIPT" });
    const duplicateNested = '{"receipt":{"job_id":"7","job_id":"8"},"signature":"0x00"}';
    assert.throws(() => parseMeteringJson(duplicateNested), { code: "MALFORMED_RECEIPT" });
    const escapedDuplicate = '{"a":0,"\\u0061":1}';
    assert.throws(() => parseMeteringJson(escapedDuplicate), { code: "MALFORMED_RECEIPT" });
    assert.throws(() => parseMeteringJson('{"a":[1,2,]}'), {
      code: "MALFORMED_RECEIPT",
    });
  });

  it("rejects invalid signature encodings and high-S malleability", () => {
    assert.throws(
      () => parseSignedMeteringReceipt({ receipt, signature: "0x" + "00".repeat(65) }),
      { code: "SIGNATURE_INVALID" },
    );
    const highS = ("0x" +
      vectors.valid.signature.slice(2, 66) +
      "ff".repeat(32) +
      "1b") as Hex;
    assert.throws(() => parseSignedMeteringReceipt({ receipt, signature: highS }), {
      code: "SIGNATURE_INVALID",
    });
  });

  it("rejects tampering and unauthorized meter keys", async () => {
    await assert.rejects(
      () => verifyMeteringReceipt({ ...envelope, receipt: changed({ cpu_time_ns: 1_120_000_001 }) as MeteringReceipt }, context),
      { code: "SIGNER_MISMATCH" },
    );
    await assert.rejects(
      () => verifyMeteringReceipt(envelope, {
        ...context,
        expectedSigner: "0x2222222222222222222222222222222222222222",
      }),
      { code: "SIGNER_MISMATCH" },
    );
    for (const [patch, errorCode] of [
      [{ chainId: 8453 }, "CHAIN_MISMATCH"],
      [{ jobId: "8" }, "JOB_MISMATCH"],
      [{ evaluatorAddress: "0x2000000000000000000000000000000000000002" }, "EVALUATOR_MISMATCH"],
      [{ specHash: "0x" + "55".repeat(32) }, "SPEC_MISMATCH"],
      [{ deliverableHash: "0x" + "66".repeat(32) }, "DELIVERABLE_MISMATCH"],
      [{ containerDigest: "different-image" }, "CONTAINER_MISMATCH"],
    ] as const) {
      await assert.rejects(
        () => verifyMeteringReceipt(envelope, { ...context, ...patch } as MeteringVerificationContext),
        { code: errorCode },
      );
    }
  });

  it("does not mistake a malformed artifact for an authenticated receipt", async () => {
    assert.ok(MeteringReceiptError.prototype instanceof Error);
    await assert.rejects(
      () => verifyMeteringReceipt(
        { receipt: changed({ nonce: "0x" + "77".repeat(32) }) as MeteringReceipt, signature: envelope.signature },
        context,
      ),
      { code: "SIGNER_MISMATCH" },
    );
  });
});
