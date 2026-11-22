import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData } from "viem";
import type { Address, Hex } from "viem";

import {
  MAX_PROOF_BYTES,
  RelayError,
  SIGNAL_ABI,
  parsePolls,
  pollOf,
  parseRelayRequest,
  relaySignal,
} from "../src/relay.ts";
import type { RelayChain, RelayConfig, RelayRefusal } from "../src/relay.ts";

const SIGNAL: Address = "0x87C05cB26FFB56181ca561Dd9c11DD5D9d2ea2d4";
const HASH: Hex = `0x${"11".repeat(32)}`;
const config: RelayConfig = {
  signal: SIGNAL,
  scopes: [(3n << 128n) | 7n],
  maxFeePerGas: 500_000_000n,
  maxGas: 4_500_000n,
};
const body = {
  groupId: "3",
  scope: ((3n << 128n) | 7n).toString(),
  message: "2",
  root: "123456789",
  nullifier: "987654321",
  proof: "0x" + "ab".repeat(64),
};

/** A chain that records what it is asked, with a fee and a simulation result that can be set. */
function chain(over: Partial<{ fee: bigint; used: bigint; reverts: boolean }> = {}) {
  const sent: { to: Address; data: Hex; gas: bigint; maxFeePerGas: bigint }[] = [];
  let simulated = 0;
  const c: RelayChain = {
    feePerGas: () => Promise.resolve(over.fee ?? 6_000_000n),
    simulate: () => {
      simulated += 1;
      return over.reverts
        ? Promise.reject(new Error("execution reverted"))
        : Promise.resolve(over.used ?? 3_000_000n);
    },
    send: (call) => {
      sent.push(call);
      return Promise.resolve(HASH);
    },
  };
  return { c, sent, simulated: () => simulated };
}

const refused = async (run: () => Promise<unknown>, code: RelayRefusal) =>
  assert.rejects(run, (e: unknown) => e instanceof RelayError && e.code === code);

describe("relay request", () => {
  it("reads decimal strings and a hex proof", () => {
    const r = parseRelayRequest(body);
    assert.equal(r.groupId, 3n);
    assert.equal(r.scope, (3n << 128n) | 7n);
    assert.equal(r.message, 2n);
    assert.equal(r.proof, body.proof);
  });

  it("refuses anything else", () => {
    const bad = (b: unknown) => {
      assert.throws(
        () => parseRelayRequest(b),
        (e: unknown) => e instanceof RelayError && e.code === "bad-request",
      );
    };
    bad(null);
    bad([]);
    bad("x");
    bad({ ...body, groupId: 3 });
    bad({ ...body, scope: "0x10" });
    bad({ ...body, message: "-1" });
    bad({ ...body, root: (1n << 256n).toString() });
    bad({ ...body, nullifier: undefined });
    bad({ ...body, proof: "abcd" });
    bad({ ...body, proof: "0x" });
    bad({ ...body, proof: "0xabc" });
    bad({ ...body, proof: "0x" + "ab".repeat(MAX_PROOF_BYTES + 1) });
  });
});

describe("relaying a signal", () => {
  it("simulates, then sends exactly the member's signal to the contract", async () => {
    const { c, sent } = chain();
    const out = await relaySignal(parseRelayRequest(body), config, c);
    assert.equal(out.transaction, HASH);
    assert.equal(sent.length, 1);
    const call = sent[0];
    if (!call) assert.fail("nothing was sent");
    assert.equal(call.to, SIGNAL);
    const decoded = decodeFunctionData({ abi: SIGNAL_ABI, data: call.data });
    assert.equal(decoded.functionName, "signal");
    assert.deepEqual(decoded.args, [3n, (3n << 128n) | 7n, 2n, 123456789n, 987654321n, body.proof]);
    // A fifth above the simulated gas, at the relayer's own fee ceiling.
    assert.equal(call.gas, 3_600_000n);
    assert.equal(call.maxFeePerGas, config.maxFeePerGas);
  });

  it("serves only its polls, so nobody spends its balance on a group or a poll of their own", async () => {
    const { c, sent, simulated } = chain();
    const otherGroup = { ...body, groupId: "4", scope: ((4n << 128n) | 7n).toString() };
    await refused(() => relaySignal(parseRelayRequest(otherGroup), config, c), "poll-not-served");
    // A member of a served group cannot open poll after poll at the relayer's cost.
    const otherPoll = { ...body, scope: ((3n << 128n) | 8n).toString() };
    await refused(() => relaySignal(parseRelayRequest(otherPoll), config, c), "poll-not-served");
    assert.equal(simulated(), 0);
    assert.equal(sent.length, 0);
  });

  it("refuses a scope of another group before asking the chain", async () => {
    const { c, sent, simulated } = chain();
    const foreign = { ...body, scope: ((4n << 128n) | 7n).toString() };
    await refused(() => relaySignal(parseRelayRequest(foreign), config, c), "scope-not-for-group");
    assert.equal(simulated(), 0);
    assert.equal(sent.length, 0);
  });

  it("sends nothing the contract would refuse", async () => {
    const { c, sent } = chain({ reverts: true });
    await refused(() => relaySignal(parseRelayRequest(body), config, c), "refused-by-contract");
    assert.equal(sent.length, 0);
  });

  it("sends nothing when the fee is above its ceiling or the gas above its limit", async () => {
    const dear = chain({ fee: config.maxFeePerGas + 1n });
    await refused(() => relaySignal(parseRelayRequest(body), config, dear.c), "fee-too-high");
    assert.equal(dear.sent.length, 0);
    assert.equal(dear.simulated(), 0);

    const heavy = chain({ used: 4_000_000n });
    await refused(() => relaySignal(parseRelayRequest(body), config, heavy.c), "too-much-gas");
    assert.equal(heavy.sent.length, 0);
  });
});

describe("served polls setting", () => {
  it("reads group:poll pairs and serves none when the setting is missing or broken", () => {
    assert.deepEqual(parsePolls("0:1,3:7, 3:8"), [1n, (3n << 128n) | 7n, (3n << 128n) | 8n]);
    assert.deepEqual(parsePolls("3:7,3:7"), [(3n << 128n) | 7n]);
    assert.deepEqual(parsePolls(undefined), []);
    assert.deepEqual(parsePolls(""), []);
    assert.deepEqual(parsePolls("3"), []);
    assert.deepEqual(parsePolls("3:7,x:1"), []);
    assert.deepEqual(parsePolls("3:-1"), []);
    assert.deepEqual(parsePolls(`${(1n << 128n).toString()}:1`), []);
    assert.deepEqual(pollOf((3n << 128n) | 7n), { group: 3n, poll: 7n });
  });
});
