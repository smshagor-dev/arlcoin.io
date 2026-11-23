// Bounded local artifact handoff for a provider-signed metering receipt.
// This is deliberately NOT a network transport or a registry authorization mechanism.
// The caller must obtain the expected SHA-256 from a separately authenticated source.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { Hex } from "viem";

import {
  MeteringReceiptError,
  parseSignedMeteringReceiptJson,
  type SignedMeteringReceipt,
} from "./receipt.ts";

export const MAX_SIGNED_METERING_ARTIFACT_BYTES = 65_536;

export interface PinnedMeteringArtifact {
  signed: SignedMeteringReceipt;
  sha256: Hex;
}

function artifactError(message: string): never {
  throw new MeteringReceiptError("METER_ARTIFACT_UNAVAILABLE", message);
}

/**
 * Securely import a trusted-local-file-delivered receipt, without following a
 * final-component symlink or reading a potentially unbounded special file.
 *
 * A size-bounded positional read protects against a file enlarged between stat/read.
 * Both the strict JSON parser and the content pin must match before returning.
 * The validator must still authenticate signer registration and verify EIP-712.
 */
export async function readPinnedMeteringArtifact(
  filePath: string,
  expectedSha256: Hex,
): Promise<PinnedMeteringArtifact> {
  if (
    typeof filePath !== "string" ||
    !isAbsolute(filePath) ||
    filePath.includes("\0") ||
    typeof expectedSha256 !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(expectedSha256)
  ) {
    return artifactError("file path or authenticated content digest is invalid");
  }
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    return artifactError("local file transport requires O_NOFOLLOW support");
  }
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let file;
  try {
    file = await open(filePath, flags);
  } catch {
    return artifactError("cannot open signed receipt as a regular local file");
  }

  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size > MAX_SIGNED_METERING_ARTIFACT_BYTES ||
      before.size < 1
    ) {
      return artifactError("signed receipt is not a bounded regular file");
    }
    const parts: Buffer[] = [];
    let total = 0;
    while (total <= MAX_SIGNED_METERING_ARTIFACT_BYTES) {
      const remaining = MAX_SIGNED_METERING_ARTIFACT_BYTES - total + 1;
      const chunk = Buffer.alloc(Math.min(8_192, remaining));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      parts.push(chunk.subarray(0, bytesRead));
    }
    if (total > MAX_SIGNED_METERING_ARTIFACT_BYTES || total !== before.size) {
      return artifactError("signed receipt changed or exceeded the size limit during read");
    }
    const after = await file.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return artifactError("signed receipt changed during read");
    }
    bytes = Buffer.concat(parts, total);
  } catch (error) {
    if (error instanceof MeteringReceiptError) throw error;
    return artifactError("cannot read the signed receipt safely");
  } finally {
    await file.close();
  }

  const sha256 = ("0x" + createHash("sha256").update(bytes).digest("hex")) as Hex;
  if (sha256 !== expectedSha256) {
    return artifactError("signed receipt differs from the authenticated SHA-256 pin");
  }

  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return artifactError("signed receipt is not valid UTF-8");
  }
  return { signed: parseSignedMeteringReceiptJson(json), sha256 };
}
