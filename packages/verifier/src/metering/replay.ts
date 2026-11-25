// Provisional durable replay guard for trusted validator hosts.
// Policy: a validator state directory accepts at most one meter receipt for each
// (chain, evaluator, job). This is deliberately stricter than per-nonce uniqueness.
// It is not enabled by default until upstream confirms job-level replay semantics.

import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { Address } from "viem";

import { canonicalHash } from "../canonical.ts";
import { MeteringReceiptError, type VerifiedMeteringReceipt } from "./receipt.ts";

export interface MeteringReplayStore {
  consume(verified: VerifiedMeteringReceipt): Promise<void>;
}

function replayError(code: string, reason: string): MeteringReceiptError {
  return new MeteringReceiptError(code, reason);
}

/**
 * An exclusive-create marker is atomic across processes on a local filesystem.
 * Failed verification must occur BEFORE consume(), so invalid receipts never reserve a job.
 *
 * A crash after marker creation may leave a partial marker. It remains reserved:
 * this deliberately fails closed and requires explicit operator reconciliation.
 * Never use a network filesystem that does not guarantee exclusive-create semantics.
 */
export class FileMeteringReplayStore implements MeteringReplayStore {
  private readonly directory: string;
  private readonly validator: Address;

  constructor(directory: string, validator: Address) {
    if (!isAbsolute(directory) || directory.includes("\0")) {
      throw replayError("REPLAY_STORAGE_UNAVAILABLE", "replay state directory must be trusted");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(validator)) {
      throw replayError("REPLAY_STORAGE_UNAVAILABLE", "validator identity must be an EVM address");
    }
    this.directory = directory;
    this.validator = validator.toLowerCase() as Address;
  }

  async consume(verified: VerifiedMeteringReceipt): Promise<void> {
    if (!Object.hasOwn(verified, "receipt") || typeof verified.receiptHash !== "string") {
      throw replayError("REPLAY_STORAGE_UNAVAILABLE", "verified receipt is required");
    }
    const receipt = verified.receipt;
    const key = canonicalHash({
      chain_id: receipt.chain_id,
      evaluator_address: receipt.evaluator_address,
      job_id: receipt.job_id,
      validator: this.validator,
    });
    const path = join(this.directory, key.slice(2) + ".json");
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    } catch {
      throw replayError("REPLAY_STORAGE_UNAVAILABLE", "cannot create replay state directory");
    }

    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw replayError("REPLAY_DETECTED", "meter receipt already reserved for this job");
      }
      throw replayError("REPLAY_STORAGE_UNAVAILABLE", "cannot reserve receipt in durable store");
    }

    try {
      await file.writeFile(
        JSON.stringify({
          version: "arl-metering-replay/1",
          receipt_hash: verified.receiptHash,
          signer: verified.signer,
          chain_id: receipt.chain_id,
          evaluator_address: receipt.evaluator_address,
          job_id: receipt.job_id,
          validator: this.validator,
          run_id: receipt.run_id,
          nonce: receipt.nonce,
        }) + "\n",
        "utf8",
      );
      await file.sync();
      // Sync the directory entry on Linux so a successful return has a durable name.
      if (process.platform === "linux") {
        const parent = await open(this.directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } catch {
      // Do NOT unlink a potentially visible marker: another process may have observed
      // it, and removing it could authorize the same job twice.
      throw replayError(
        "REPLAY_STORAGE_UNAVAILABLE",
        "replay marker persistence failed; job remains reserved",
      );
    } finally {
      await file.close();
    }
  }
}
