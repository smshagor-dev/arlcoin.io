/* eslint-disable no-console -- an operator script that reports to the terminal */
// Builds the Safe transaction that switches the buyer agent on, and proves it on a local fork of
// Base Mainnet by executing it through the real Ecosystem & Growth Safe with two owner approvals
// (approveHash from two impersonated owners, then execTransaction), exactly as the owners will
// sign it. Then it checks the module, the delegate and the allowance.
//
//   node packages/magnet-agent/fork/safe-batch.ts <agentAddress> [amountArl=5000] [--out file.json]

import { writeFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  zeroAddress,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";

import {
  ALLOWANCE_MODULE,
  ECOSYSTEM_SAFE,
  MULTI_SEND_CALL_ONLY,
  allowanceCalls,
  allowanceLeft,
  multiSendData,
  transactionBuilderJson,
  ARL_TOKEN,
} from "../src/index.ts";

const [agentArg, amountArg, ...rest] = process.argv.slice(2);
if (!agentArg) throw new Error("usage: safe-batch.ts <agentAddress> [amountArl] [--out file]");
const agent = getAddress(agentArg);
const amount = parseUnits(amountArg && !amountArg.startsWith("--") ? amountArg : "5000", 18);
const outIndex = rest.indexOf("--out");
const out = outIndex >= 0 ? rest[outIndex + 1] : undefined;
const RPC = process.env.RPC ?? "http://127.0.0.1:18547";

const chain = { ...base, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) }) as unknown as PublicClient;
const rpc = (method: string, params: unknown[]) =>
  fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);
const moduleAbi = parseAbi([
  "function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)",
]);

const enabled = await pub.readContract({
  address: ECOSYSTEM_SAFE,
  abi: safeAbi,
  functionName: "isModuleEnabled",
  args: [ALLOWANCE_MODULE],
});
const calls = allowanceCalls(agent, amount, !enabled);
const json = transactionBuilderJson(calls, `ARL buyer agent: allowance ${amountArg ?? "5000"} ARL`);
if (out) writeFileSync(out, `${json}\n`);
const data = multiSendData(calls);
console.log("calls", calls.length, "module already enabled", enabled);

const owners = await pub.readContract({
  address: ECOSYSTEM_SAFE,
  abi: safeAbi,
  functionName: "getOwners",
});
const nonce = await pub.readContract({
  address: ECOSYSTEM_SAFE,
  abi: safeAbi,
  functionName: "nonce",
});
const hash = await pub.readContract({
  address: ECOSYSTEM_SAFE,
  abi: safeAbi,
  functionName: "getTransactionHash",
  args: [MULTI_SEND_CALL_ONLY, 0n, data, 1, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
});
const signers = [...owners].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, 2);
for (const owner of signers) {
  await rpc("anvil_impersonateAccount", [owner]);
  await rpc("anvil_setBalance", [owner, "0xDE0B6B3A7640000"]);
  const w = createWalletClient({ account: owner, chain, transport: http(RPC) });
  await pub.waitForTransactionReceipt({
    hash: await w.writeContract({
      address: ECOSYSTEM_SAFE,
      abi: safeAbi,
      functionName: "approveHash",
      args: [hash],
    }),
  });
}
// Pre-validated signatures (v = 1), sorted by owner, as Safe requires.
const signatures: `0x${string}` = `0x${signers.map((o) => `${o.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01`).join("")}`;
const first = signers[0];
if (!first) throw new Error("the Safe has no owners");
const w = createWalletClient({ account: first, chain, transport: http(RPC) });
const exec = await w.writeContract({
  address: ECOSYSTEM_SAFE,
  abi: safeAbi,
  functionName: "execTransaction",
  args: [MULTI_SEND_CALL_ONLY, 0n, data, 1, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
});
const r = await pub.waitForTransactionReceipt({ hash: exec });

const nowEnabled = await pub.readContract({
  address: ECOSYSTEM_SAFE,
  abi: safeAbi,
  functionName: "isModuleEnabled",
  args: [ALLOWANCE_MODULE],
});
const [delegates] = await pub.readContract({
  address: ALLOWANCE_MODULE,
  abi: moduleAbi,
  functionName: "getDelegates",
  args: [ECOSYSTEM_SAFE, 0, 50],
});
const left = await allowanceLeft(pub, agent, ARL_TOKEN);
console.log(
  "exec status",
  r.status,
  "module enabled",
  nowEnabled,
  "agent is delegate",
  delegates.includes(agent),
  "allowance left",
  String(left),
);
const ok = r.status === "success" && nowEnabled && delegates.includes(agent) && left === amount;
console.log(ok ? "SAFE BATCH OK" : "SAFE BATCH FAILED");
if (out) console.log("Transaction Builder file:", out);
process.exit(ok ? 0 : 1);
