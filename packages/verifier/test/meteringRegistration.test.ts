import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Address, Hex, PublicClient } from "viem";

import {
  resolveMeterSigner,
  verifyRegisteredMeteringReceipt,
  type MeterRegistrationSnapshot,
} from "../src/metering/registration.ts";
import type { MeteringReceipt } from "../src/metering/receipt.ts";

const evaluator: Address = "0x1000000000000000000000000000000000000001";
const jobs: Address = "0x2000000000000000000000000000000000000002";
const registry: Address = "0x3000000000000000000000000000000000000003";
const provider: Address = "0x4000000000000000000000000000000000000004";
const signer: Address = "0x281c6e8b0cc09df345fb88c4cb30201d561a5c5e";

function pin(bytes: Uint8Array): Hex {
  return ("0x" + createHash("sha256").update(bytes).digest("hex")) as Hex;
}

const document = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Registered provider",
  registrations: [{ agentRegistry: "eip155:31337:" + registry, agentId: 17 }],
  extensions: { "arl-metering-receipt/1": { signer } },
};

function snapshot(raw: unknown = document): MeterRegistrationSnapshot {
  const bytes = Buffer.from(JSON.stringify(raw), "utf8");
  return {
    chainId: 31337,
    evaluatorAddress: evaluator,
    jobId: 7n,
    registrationBlock: 42n,
    expectedRegistrationUri: "https://example.org/agent.json",
    registrationBytes: bytes,
    pinnedRegistrationSha256: pin(bytes),
  };
}

function chain(
  options: { owner?: Address; provider?: Address; agentId?: bigint; uri?: string } = {},
) {
  const calls: { functionName: string; blockNumber?: bigint }[] = [];
  const client = {
    getChainId: async () => 31337,
    readContract: async ({
      functionName,
      blockNumber,
    }: {
      functionName: string;
      blockNumber?: bigint;
    }) => {
      calls.push({ functionName, ...(blockNumber === undefined ? {} : { blockNumber }) });
      if (functionName === "identity") return registry;
      if (functionName === "jobs") return jobs;
      if (functionName === "getConfig") return { providerAgentId: options.agentId ?? 17n };
      if (functionName === "getJob") {
        return { id: 7n, provider: options.provider ?? provider, evaluator };
      }
      if (functionName === "ownerOf") return options.owner ?? provider;
      if (functionName === "tokenURI") return options.uri ?? "https://example.org/agent.json";
      throw new Error("unexpected read " + functionName);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe("pinned historical ERC-8004 meter registration", () => {
  it("binds signer to historical provider, agent, registry and document pin", async () => {
    const { client, calls } = chain();
    const resolved = await resolveMeterSigner(client, snapshot());
    assert.equal(resolved.expectedSigner, signer);
    assert.equal(resolved.provider, provider);
    assert.equal(resolved.agentId, 17n);
    assert.equal(resolved.registry, registry);
    assert.equal(resolved.registrationBlock, 42n);
    assert.equal(calls.length, 6);
    assert.ok(calls.every((call) => call.blockNumber === 42n));
  });

  it("rejects an agent owned by somebody other than the committed job provider", async () => {
    const { client } = chain({ owner: "0x9999999999999999999999999999999999999999" });
    await assert.rejects(() => resolveMeterSigner(client, snapshot()), {
      code: "REGISTRATION_UNAVAILABLE",
    });
  });

  it("refuses a historical URI that differs from the independently pinned URI", async () => {
    await assert.rejects(
      () => resolveMeterSigner(chain({ uri: "https://other.example.org/agent.json" }).client, snapshot()),
      { code: "REGISTRATION_UNAVAILABLE" },
    );
  });

  it("rejects a registration file whose bytes differ from the pinned historical hash", async () => {
    const { client } = chain();
    const context = snapshot();
    const replaced = { ...context, registrationBytes: Buffer.from('{"signer":"hijacked"}') };
    await assert.rejects(() => resolveMeterSigner(client, replaced), {
      code: "REGISTRATION_UNAVAILABLE",
    });
  });

  it("rejects missing agent identity, wrong cross-reference and unsupported URI", async () => {
    const context = snapshot();
    await assert.rejects(() => resolveMeterSigner(chain({ agentId: 0n }).client, context), {
      code: "REGISTRATION_UNAVAILABLE",
    });
    const wrongRegistration = snapshot({
      ...document,
      registrations: [{ agentRegistry: "eip155:8453:" + registry, agentId: 17 }],
    });
    await assert.rejects(
      () => resolveMeterSigner(chain().client, wrongRegistration),
      { code: "REGISTRATION_UNAVAILABLE" },
    );
    await assert.rejects(
      () => resolveMeterSigner(chain({ uri: "ftp://attacker.invalid/metadata" }).client, context),
      { code: "REGISTRATION_UNAVAILABLE" },
    );
  });

  it("rejects duplicate registration keys and missing metering extensions", async () => {
    const { client } = chain();
    await assert.rejects(
      () => resolveMeterSigner(client, snapshot({ ...document, extensions: {} })),
      { code: "REGISTRATION_UNAVAILABLE" },
    );
    const raw = '{"name":"first","name":"second"}';
    const bytes = Buffer.from(raw);
    const invalid = {
      ...snapshot(),
      registrationBytes: bytes,
      pinnedRegistrationSha256: pin(bytes),
    };
    await assert.rejects(() => resolveMeterSigner(client, invalid), {
      code: "REGISTRATION_UNAVAILABLE",
    });
  });

  it("rejects missing a trusted pin before any on-chain lookups", async () => {
    const { client, calls } = chain();
    await assert.rejects(
      () =>
        resolveMeterSigner(client, {
          ...snapshot(),
          pinnedRegistrationSha256: ("0x" + "0".repeat(63)) as Hex,
        }),
      { code: "REGISTRATION_UNAVAILABLE" },
    );
    assert.equal(calls.length, 0);
  });

  it("verifies the signed receipt vector using pinned registration", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../../spec/arl-metering-receipt/v0.1.0/vectors.json", import.meta.url),
        "utf8",
      ),
    ) as { valid: { receipt: MeteringReceipt; signature: Hex } };
    const signed = { receipt: fixture.valid.receipt, signature: fixture.valid.signature };
    const context = {
      chainId: 31337,
      evaluatorAddress: evaluator,
      jobId: "7",
      specHash: signed.receipt.spec_hash,
      deliverableHash: signed.receipt.deliverable_hash,
      containerDigest: signed.receipt.container_digest,
    };
    const verified = await verifyRegisteredMeteringReceipt(
      chain().client,
      signed,
      context,
      snapshot(),
    );
    assert.equal(verified.signer, signer);
    assert.equal(verified.receipt.job_id, "7");

    await assert.rejects(
      () =>
        verifyRegisteredMeteringReceipt(
          chain().client,
          { ...signed, receipt: { ...signed.receipt, cpu_time_ns: 1_120_000_001 } },
          context,
          snapshot(),
        ),
      { code: "SIGNER_MISMATCH" },
    );
    await assert.rejects(
      () =>
        verifyRegisteredMeteringReceipt(
          chain().client,
          signed,
          { ...context, jobId: "8" },
          snapshot(),
        ),
      { code: "REGISTRATION_UNAVAILABLE" },
    );
  });
});
