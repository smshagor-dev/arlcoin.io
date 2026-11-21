import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STATUS_CONTRACTS, hasCode, minutesBehind, readStatus } from "../../src/content/status.ts";

const VALIDATORS = {
  chainId: 8453,
  block: "60517009",
  validators: [
    {
      token: "ARL",
      validator: "0x7E8e18bf48F07B82F64b846b0d509ad79FD86244",
      accepted: 1,
      slashes: 0,
      stake: "300000000000000000000",
    },
    { token: "ARL", validator: "0xbroken" },
  ],
};
const AGENT = { registered: true, completed: 2, rejected: 0 };

/** A fetch that answers like Base and the Agent API, or fails where `down` says so. */
function fakeFetch(down: { rpc?: boolean; api?: boolean; noCodeAt?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    // The API is asked by path; only the chain endpoint is a full address.
    const host = URL.canParse(url) ? new URL(url).host : "";
    if (host === "mainnet.base.org") {
      if (down.rpc) throw new Error("unreachable");
      const batch = JSON.parse(String(init?.body)) as { id: number; method: string }[];
      return reply(
        batch.map((call) => ({
          id: call.id,
          result:
            call.method === "eth_blockNumber"
              ? "0x39b6f8d" // 60518285
              : call.id === down.noCodeAt
                ? "0x"
                : "0x6080",
        })),
      );
    }
    if (down.api) return new Response("bad gateway", { status: 502 });
    if (url.endsWith("/api/v1/validators")) return reply(VALIDATORS);
    if (url.endsWith("/api/v1/health")) {
      return reply({ ok: true, rpcs: [{ ok: true, block: "60518240" }, { ok: false }] });
    }
    return reply(AGENT);
  }) as typeof fetch;
}

describe("network status", () => {
  it("turns a block distance into minutes and never goes below zero", () => {
    assert.equal(minutesBehind(60518285, 60517009), 43);
    assert.equal(minutesBehind(100, 130), 0);
  });

  it("counts a contract as answering only when the chain returns code", () => {
    assert.equal(hasCode("0x6080"), true);
    assert.equal(hasCode("0x"), false);
    assert.equal(hasCode(undefined), false);
  });

  it("reads the chain, the contracts, the API, the validators and the agent", async () => {
    const s = await readStatus(fakeFetch());
    assert.equal(s.chain.ok && s.chain.block, 60518285);
    assert.deepEqual(
      s.contracts,
      STATUS_CONTRACTS.map(() => ({ ok: true })),
    );
    assert.equal(s.api.ok, true);
    assert.deepEqual(s.history, { block: 60517009, minutesBehind: 43 });
    // An entry that is not a validator record is left out, not shown half empty.
    assert.equal(s.validators?.length, 1);
    assert.deepEqual(s.agent, { registered: true, completed: 2, rejected: 0 });
  });

  it("reports a contract without code as such", async () => {
    const s = await readStatus(fakeFetch({ noCodeAt: 2 }));
    assert.equal(s.contracts[1]?.ok, false);
    assert.equal(s.contracts[0]?.ok, true);
  });

  it("takes the head from the API and leaves the contracts unchecked when Base is unreachable", async () => {
    const s = await readStatus(fakeFetch({ rpc: true }));
    assert.equal(s.chain.ok && s.chain.block, 60518240);
    assert.deepEqual(
      s.contracts,
      STATUS_CONTRACTS.map(() => ({ ok: null })),
    );
  });

  it("reports the API as not answering without throwing", async () => {
    const s = await readStatus(fakeFetch({ api: true }));
    assert.equal(s.api.ok, false);
    assert.equal(s.history, null);
    assert.equal(s.validators, null);
    assert.equal(s.agent, null);
    assert.equal(s.chain.ok, true);
  });
});
