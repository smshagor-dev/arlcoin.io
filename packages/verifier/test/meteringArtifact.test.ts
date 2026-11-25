import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Hex } from "viem";

import {
  MAX_SIGNED_METERING_ARTIFACT_BYTES,
  publishSignedMeteringArtifact,
  readPinnedMeteringArtifact,
} from "../src/metering/artifact.ts";
import { verifyMeteringReceipt, type MeteringReceipt } from "../src/metering/receipt.ts";

interface Fixtures {
  valid: {
    receipt: MeteringReceipt;
    signature: Hex;
    expected_signer: Hex;
  };
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../spec/arl-metering-receipt/v0.1.0/vectors.json", import.meta.url),
    "utf8",
  ),
) as Fixtures;
const envelope = { receipt: vectors.valid.receipt, signature: vectors.valid.signature };

function pin(bytes: Uint8Array): Hex {
  return ("0x" + createHash("sha256").update(bytes).digest("hex")) as Hex;
}

const supportsNoFollow = typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0;

describe(
  "bounded pinned local receipt artifact transport",
  {
    skip: !supportsNoFollow && "requires O_NOFOLLOW filesystem support",
  },
  () => {
    it("loads a pinned signed receipt and verifies EIP-712", async () => {
      const directory = await mkdtemp(join(tmpdir(), "arl-meter-artifact-"));
      try {
        const path = join(directory, "receipt.json");
        const bytes = Buffer.from(JSON.stringify(envelope) + "\n");
        await writeFile(path, bytes, { mode: 0o600 });
        const artifact = await readPinnedMeteringArtifact(path, pin(bytes));
        assert.equal(artifact.sha256, pin(bytes));
        assert.equal(artifact.signed.signature, vectors.valid.signature);
        const { receipt } = vectors.valid;
        const verified = await verifyMeteringReceipt(artifact.signed, {
          chainId: receipt.chain_id,
          evaluatorAddress: receipt.evaluator_address,
          jobId: receipt.job_id,
          specHash: receipt.spec_hash,
          deliverableHash: receipt.deliverable_hash,
          containerDigest: receipt.container_digest,
          expectedSigner: vectors.valid.expected_signer,
        });
        assert.equal(verified.receipt.job_id, receipt.job_id);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("atomically publishes a private complete artifact and refuses overwrites", async () => {
      const directory = await mkdtemp(join(tmpdir(), "arl-meter-publish-"));
      try {
        const destination = join(directory, "receipt.json");
        const publication = await publishSignedMeteringArtifact(destination, envelope);
        const imported = await readPinnedMeteringArtifact(destination, publication.sha256);
        assert.deepEqual(imported.signed, envelope);
        assert.equal(publication.byteLength, (await stat(destination)).size);
        if (process.platform !== "win32") {
          assert.equal((await stat(destination)).mode & 0o777, 0o600);
        }

        await assert.rejects(() => publishSignedMeteringArtifact(destination, envelope), {
          code: "METER_ARTIFACT_UNAVAILABLE",
        });
        assert.deepEqual(await readdir(directory), ["receipt.json"]);
        assert.equal(
          (await readPinnedMeteringArtifact(destination, publication.sha256)).sha256,
          publication.sha256,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("publishes once even when two writers compete for the same output path", async () => {
      const directory = await mkdtemp(join(tmpdir(), "arl-meter-concurrent-"));
      try {
        const destination = join(directory, "receipt.json");
        const [first, second] = await Promise.allSettled([
          publishSignedMeteringArtifact(destination, envelope),
          publishSignedMeteringArtifact(destination, envelope),
        ]);
        const attempts = [first, second];
        assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
        assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
        assert.deepEqual(await readdir(directory), ["receipt.json"]);
        const succeeded = attempts.find((x) => x.status === "fulfilled");
        assert.ok(succeeded);
        const read = await readPinnedMeteringArtifact(destination, succeeded.value.sha256);
        assert.equal(read.signed.receipt.job_id, envelope.receipt.job_id);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects changed, missing or oversized artifacts before parsing", async () => {
      const directory = await mkdtemp(join(tmpdir(), "arl-meter-bad-file-"));
      try {
        const path = join(directory, "receipt.json");
        const bytes = Buffer.from(JSON.stringify(envelope));
        const expected = pin(bytes);
        await writeFile(path, bytes);
        await writeFile(path, JSON.stringify({ ...envelope, signature: "0xdead" }));
        await assert.rejects(() => readPinnedMeteringArtifact(path, expected), {
          code: "METER_ARTIFACT_UNAVAILABLE",
        });
        await writeFile(path, Buffer.alloc(MAX_SIGNED_METERING_ARTIFACT_BYTES + 1));
        await assert.rejects(() => readPinnedMeteringArtifact(path, expected), {
          code: "METER_ARTIFACT_UNAVAILABLE",
        });
        await assert.rejects(
          () => readPinnedMeteringArtifact(join(directory, "missing.json"), expected),
          { code: "METER_ARTIFACT_UNAVAILABLE" },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("refuses final-component symlinks and untrusted relative paths", async () => {
      const directory = await mkdtemp(join(tmpdir(), "arl-meter-symlink-"));
      try {
        const target = join(directory, "real.json");
        const link = join(directory, "receipt.json");
        const bytes = Buffer.from(JSON.stringify(envelope));
        await writeFile(target, bytes);
        await symlink(target, link);
        await assert.rejects(() => readPinnedMeteringArtifact(link, pin(bytes)), {
          code: "METER_ARTIFACT_UNAVAILABLE",
        });
        await assert.rejects(() => readPinnedMeteringArtifact("./receipt.json", pin(bytes)), {
          code: "METER_ARTIFACT_UNAVAILABLE",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects invalid UTF-8 and duplicate JSON keys even with a matching pin", async () => {
      const directory = await mkdtemp(join(tmpdir(), "arl-meter-invalid-"));
      try {
        const path = join(directory, "receipt.json");
        const duplicated = Buffer.from('{"receipt":{},"receipt":{},"signature":"0x00"}');
        await writeFile(path, duplicated);
        await assert.rejects(() => readPinnedMeteringArtifact(path, pin(duplicated)), {
          code: "MALFORMED_RECEIPT",
        });
        const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00]);
        await writeFile(path, invalidUtf8);
        await assert.rejects(() => readPinnedMeteringArtifact(path, pin(invalidUtf8)), {
          code: "METER_ARTIFACT_UNAVAILABLE",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
