// Cloudflare Pages Function: arlcoin.io/api/zk/relay. Sends a member's anonymous signal to
// ARLAnonymousSignal, so the sender on chain is the relayer and not a wallet of the voter. The
// rule is packages/zk/src/relay.ts: only the polls named in the settings, a simulation first,
// and a fee ceiling.
//
// This is the one ARL service that holds a key. The key pays gas and nothing else: it cannot
// vote or change a vote, and the proof tells it nothing about which member voted. Like any web
// service it sees the network address a request comes from; it does not store it. The key is a
// secret of the deployment (ZK_RELAYER_KEY), set by
// the operator and never in the repository. Without it, or without the other two settings, the
// service is off and answers so.
//
//   ZK_RELAYER_KEY         the relayer account's key (secret)
//   ZK_SIGNAL              the ARLAnonymousSignal address
//   ZK_RELAY_POLLS         the polls it pays for, as group:poll pairs, e.g. "0:1,0:2"
//   ZK_RELAY_MAX_FEE_GWEI  the most it pays per unit of gas (default 0.5)
import {
  createPublicClient,
  createWalletClient,
  fallback,
  getAddress,
  http,
  isAddress,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import {
  RelayError,
  parsePolls,
  parseRelayRequest,
  pollOf,
  relaySignal,
} from "../../../packages/zk/src/relay.ts";

const RPCS = [
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
];
/** Priority fee: Base needs next to none. */
const TIP = 1_000_000n;
/** No signal of this circuit needs more. */
const MAX_GAS = 4_500_000n;
/** A request body is a proof of about 8 kB in hex, and five numbers. */
const MAX_BODY = 80_000;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function settings(env) {
  const key = env.ZK_RELAYER_KEY;
  const signal = env.ZK_SIGNAL;
  const scopes = parsePolls(env.ZK_RELAY_POLLS);
  if (typeof key !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined;
  if (typeof signal !== "string" || !isAddress(signal) || scopes.length === 0) return undefined;
  let maxFeePerGas;
  try {
    maxFeePerGas = parseGwei(env.ZK_RELAY_MAX_FEE_GWEI ?? "0.5");
  } catch {
    return undefined;
  }
  return {
    account: privateKeyToAccount(key),
    config: { signal: getAddress(signal), scopes, maxFeePerGas, maxGas: MAX_GAS },
  };
}

/** Whether the relayer is on, and for which polls. Never anything about the key. */
export function onRequestGet({ env }) {
  const s = settings(env);
  if (!s) return json(200, { enabled: false });
  return json(200, {
    enabled: true,
    relayer: s.account.address,
    signal: s.config.signal,
    polls: s.config.scopes.map((scope) => {
      const { group, poll } = pollOf(scope);
      return { group: group.toString(), poll: poll.toString() };
    }),
  });
}

export async function onRequestPost({ request, env }) {
  const s = settings(env);
  if (!s) return json(503, { error: "relayer-off" });
  // The app on this site is the only caller; another site cannot use a visitor's browser here.
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json(403, { error: "other-origin" });
  }
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json(413, { error: "too-large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "bad-request" });
  }

  const transport = fallback(RPCS.map((url) => http(url, { timeout: 5000, retryCount: 0 })));
  const reader = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ account: s.account, chain: base, transport });
  try {
    const out = await relaySignal(parseRelayRequest(body), s.config, {
      feePerGas: async () => ((await reader.getBlock()).baseFeePerGas ?? 0n) * 2n + TIP,
      simulate: (call) => reader.estimateGas({ account: s.account.address, ...call }),
      send: (call) =>
        wallet.sendTransaction({
          to: call.to,
          data: call.data,
          gas: call.gas,
          maxFeePerGas: call.maxFeePerGas,
          maxPriorityFeePerGas: TIP,
        }),
    });
    return json(200, out);
  } catch (e) {
    if (e instanceof RelayError) {
      return json(e.code === "bad-request" ? 400 : 409, { error: e.code, message: e.message });
    }
    return json(502, { error: "relay-failed" });
  }
}
