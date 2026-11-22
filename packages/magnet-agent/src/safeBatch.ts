// The one Safe transaction that switches the buyer agent on: in the Ecosystem & Growth Safe,
// enable Safe's AllowanceModule, add the agent as a delegate and allow it a fixed amount of ARL
// with no automatic reset. Built here so the owners sign exactly what was rehearsed on a fork; the
// JSON loads into the Safe{Wallet} Transaction Builder ("Load"), which bundles it into one
// MultiSend transaction.

import {
  encodeFunctionData,
  encodePacked,
  getAddress,
  parseAbi,
  size,
  type Address,
  type Hex,
} from "viem";

import { ALLOWANCE_MODULE, ECOSYSTEM_SAFE } from "./agent.ts";

export const ARL_TOKEN: Address = "0xde91E6f39D50bBd875f831dcc1134A3D7f3aaDb4";
/** Safe MultiSendCallOnly 1.4.1 on Base: plain calls only, never a delegatecall. */
export const MULTI_SEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

const safeAbi = parseAbi(["function enableModule(address module)"]);
const moduleAbi = parseAbi([
  "function addDelegate(address delegate)",
  "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
]);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions)"]);

export interface BatchCall {
  to: Address;
  value: "0";
  data: Hex;
}

/** The calls, in order. `enable` is false once the module is enabled (a later tranche, a new agent). */
export function allowanceCalls(agent: Address, amount: bigint, enable = true): BatchCall[] {
  if (amount <= 0n || amount >= 2n ** 96n) throw new Error("amount out of range");
  const calls: BatchCall[] = [];
  if (enable) {
    calls.push({
      to: ECOSYSTEM_SAFE,
      value: "0",
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: "enableModule",
        args: [ALLOWANCE_MODULE],
      }),
    });
  }
  // Adding a delegate that is already there changes nothing, so a later tranche can repeat it.
  calls.push({
    to: ALLOWANCE_MODULE,
    value: "0",
    data: encodeFunctionData({
      abi: moduleAbi,
      functionName: "addDelegate",
      args: [getAddress(agent)],
    }),
  });
  calls.push({
    to: ALLOWANCE_MODULE,
    value: "0",
    data: encodeFunctionData({
      abi: moduleAbi,
      functionName: "setAllowance",
      args: [getAddress(agent), ARL_TOKEN, amount, 0, 0],
    }),
  });
  return calls;
}

/** Safe{Wallet} Transaction Builder file for the calls. */
export function transactionBuilderJson(calls: BatchCall[], name: string): string {
  return JSON.stringify(
    {
      version: "1.0",
      chainId: "8453",
      createdAt: 0,
      meta: {
        name,
        description: "",
        txBuilderVersion: "1.18.0",
        createdFromSafeAddress: ECOSYSTEM_SAFE,
      },
      transactions: calls.map((c) => ({
        to: c.to,
        value: c.value,
        data: c.data,
        contractMethod: null,
        contractInputsValues: null,
      })),
    },
    null,
    2,
  );
}

/** The MultiSendCallOnly calldata the Transaction Builder produces for the same calls. */
export function multiSendData(calls: BatchCall[]): Hex {
  const packed = calls.map((c) =>
    encodePacked(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [0, c.to, 0n, BigInt(size(c.data)), c.data],
    ),
  );
  const joined: Hex = `0x${packed.map((p) => p.slice(2)).join("")}`;
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [joined] });
}
