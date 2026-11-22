import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData, parseAbi } from "viem";

import { ALLOWANCE_MODULE, ECOSYSTEM_SAFE, allowanceCalls, multiSendData } from "../src/index.ts";

const AGENT = "0x00000000000000000000000000000000000A6E7A" as const;
const abi = parseAbi([
  "function enableModule(address module)",
  "function addDelegate(address delegate)",
  "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
]);

describe("allowanceCalls", () => {
  it("enables the module, adds the agent and allows the amount with no reset", () => {
    const calls = allowanceCalls(AGENT, 5000n * 10n ** 18n);
    assert.deepEqual(
      calls.map((c) => [c.to, decodeFunctionData({ abi, data: c.data }).functionName]),
      [
        [ECOSYSTEM_SAFE, "enableModule"],
        [ALLOWANCE_MODULE, "addDelegate"],
        [ALLOWANCE_MODULE, "setAllowance"],
      ],
    );
    const set = decodeFunctionData({ abi, data: calls[2]?.data ?? "0x" });
    assert.deepEqual(set.args.slice(2), [5000n * 10n ** 18n, 0, 0]);
  });

  it("skips enabling once the module is on, but still names the delegate", () => {
    const calls = allowanceCalls(AGENT, 1n, false);
    assert.deepEqual(
      calls.map((c) => decodeFunctionData({ abi, data: c.data }).functionName),
      ["addDelegate", "setAllowance"],
    );
  });

  it("refuses an amount out of range and packs every call into one multiSend", () => {
    assert.throws(() => allowanceCalls(AGENT, 0n));
    assert.throws(() => allowanceCalls(AGENT, 2n ** 96n));
    assert.match(multiSendData(allowanceCalls(AGENT, 1n)), /^0x8d80ff0a/);
  });
});
