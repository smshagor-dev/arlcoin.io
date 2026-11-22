// The relayer of anonymous signals: a service that sends a member's `signal` transaction, so the
// sender on chain is the relayer and not a wallet of the voter.
//
// It holds one key, used for gas only. It cannot vote or change a vote, and the proof tells it
// nothing about which member voted: the proof binds the group, the scope, the message and the nullifier, and the contract checks it.
// What the relayer adds is a transaction fee, so it guards the fee:
// - it relays only for the polls it is configured for, so nobody can make a group or a poll of
//   their own and spend the relayer's balance: what it can spend is one fee per member per poll;
// - it simulates the call first and sends nothing the contract would refuse;
// - it refuses when the network fee is above its ceiling.
//
// This module is the rule, with the chain behind two functions; the service that holds the key
// is functions/api/zk/relay.js. It imports nothing that proves, so it stays small.

import { encodeFunctionData, isHex, parseAbi } from "viem";
import type { Address, Hex } from "viem";

export const SIGNAL_ABI = parseAbi([
  "function signal(uint256 groupId, uint256 scope, uint256 message, uint256 root, uint256 nullifier, bytes proof)",
]);

/** A scope carries its group id above this bit (`ARLAnonymousSignal.scopeFor`). */
const SCOPE_GROUP_SHIFT = 128n;
const UINT256_MAX = (1n << 256n) - 1n;
/** An UltraHonk proof of this circuit is about 8 kB; nothing near this limit is one. */
export const MAX_PROOF_BYTES = 32_768;

export interface RelayRequest {
  groupId: bigint;
  scope: bigint;
  message: bigint;
  root: bigint;
  nullifier: bigint;
  proof: Hex;
}

export interface RelayConfig {
  /** The ARLAnonymousSignal contract. */
  signal: Address;
  /** The polls the relayer pays for, as scopes (group id above bit 128, poll number below). */
  scopes: readonly bigint[];
  /** The most the relayer pays per unit of gas, in wei. */
  maxFeePerGas: bigint;
  /** The most gas one signal may use. */
  maxGas: bigint;
}

export interface RelayChain {
  /** The fee per gas a transaction needs now, in wei. */
  feePerGas(): Promise<bigint>;
  /** Runs the call without sending it; resolves to the gas it used, rejects if it reverts. */
  simulate(call: { to: Address; data: Hex }): Promise<bigint>;
  /** Signs and sends the call; resolves to the transaction hash. */
  send(call: { to: Address; data: Hex; gas: bigint; maxFeePerGas: bigint }): Promise<Hex>;
}

export type RelayRefusal =
  | "bad-request"
  | "poll-not-served"
  | "scope-not-for-group"
  | "refused-by-contract"
  | "fee-too-high"
  | "too-much-gas";

export class RelayError extends Error {
  override name = "RelayError";
  readonly code: RelayRefusal;
  constructor(code: RelayRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

const number = (value: unknown, field: string): bigint => {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    throw new RelayError("bad-request", `${field} must be a decimal number in a string`);
  }
  const n = BigInt(value);
  if (n > UINT256_MAX) throw new RelayError("bad-request", `${field} is out of range`);
  return n;
};

/** Reads the body of a relay request: decimal strings and a hex proof, nothing else. */
export function parseRelayRequest(body: unknown): RelayRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RelayError("bad-request", "the body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const proof = b.proof;
  if (typeof proof !== "string" || !isHex(proof) || proof.length % 2 !== 0 || proof.length <= 2) {
    throw new RelayError("bad-request", "proof must be 0x-prefixed hex");
  }
  if ((proof.length - 2) / 2 > MAX_PROOF_BYTES) {
    throw new RelayError("bad-request", "proof is too long");
  }
  return {
    groupId: number(b.groupId, "groupId"),
    scope: number(b.scope, "scope"),
    message: number(b.message, "message"),
    root: number(b.root, "root"),
    nullifier: number(b.nullifier, "nullifier"),
    proof,
  };
}

/**
 * Relays one signal, or throws a RelayError saying why not. Nothing is sent unless the poll is
 * served, the contract accepts the call in a simulation, and the fee is under the ceiling.
 */
export async function relaySignal(
  request: RelayRequest,
  config: RelayConfig,
  chain: RelayChain,
): Promise<{ transaction: Hex }> {
  if (request.scope >> SCOPE_GROUP_SHIFT !== request.groupId) {
    throw new RelayError("scope-not-for-group", "the scope does not belong to the group");
  }
  if (!config.scopes.includes(request.scope)) {
    throw new RelayError("poll-not-served", "this relayer does not serve that poll");
  }
  const data = encodeFunctionData({
    abi: SIGNAL_ABI,
    functionName: "signal",
    args: [
      request.groupId,
      request.scope,
      request.message,
      request.root,
      request.nullifier,
      request.proof,
    ],
  });
  const call = { to: config.signal, data };

  const fee = await chain.feePerGas();
  if (fee > config.maxFeePerGas) {
    throw new RelayError("fee-too-high", "the network fee is above the relayer's ceiling");
  }
  let used: bigint;
  try {
    used = await chain.simulate(call);
  } catch {
    throw new RelayError(
      "refused-by-contract",
      "the contract refuses this signal (already voted, unknown root or invalid proof)",
    );
  }
  // A fifth on top of what the simulation used; a signal that needs more than the limit is not
  // one this circuit makes.
  const gas = used + used / 5n;
  if (gas > config.maxGas) {
    throw new RelayError("too-much-gas", "the signal needs more gas than the relayer allows");
  }
  return { transaction: await chain.send({ ...call, gas, maxFeePerGas: config.maxFeePerGas }) };
}

/**
 * Reads the served polls from a setting such as "0:1,0:2,3:7" (group:poll). An empty or broken
 * setting serves none.
 */
export function parsePolls(setting: string | undefined): bigint[] {
  if (!setting) return [];
  const parts = setting.split(",").map((p) => p.trim());
  const scopes: bigint[] = [];
  for (const part of parts) {
    const m = /^(\d{1,39}):(\d{1,39})$/.exec(part);
    if (!m) return [];
    const group = BigInt(m[1] ?? "0");
    const poll = BigInt(m[2] ?? "0");
    if (group >> SCOPE_GROUP_SHIFT !== 0n || poll >> SCOPE_GROUP_SHIFT !== 0n) return [];
    scopes.push((group << SCOPE_GROUP_SHIFT) | poll);
  }
  return [...new Set(scopes)];
}

/** A scope back as its group and poll numbers. */
export function pollOf(scope: bigint): { group: bigint; poll: bigint } {
  return { group: scope >> SCOPE_GROUP_SHIFT, poll: scope & ((1n << SCOPE_GROUP_SHIFT) - 1n) };
}
