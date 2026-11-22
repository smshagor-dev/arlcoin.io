/* eslint-disable no-console -- a rehearsal script that reports to the terminal */
// Rehearsal of the buyer agent on a local fork of Base Mainnet (anvil at RPC, default
// http://127.0.0.1:18547). Nothing here touches the real chain: the Safe is impersonated on the
// fork to enable the AllowanceModule and grant a 5,000 ARL allowance, exactly what the owners will
// sign later, then a fresh provider registers, the agent hires it, the provider sets a budget and
// the agent funds the job from the allowance.
//
//   node packages/magnet-agent/fork/rehearse.ts

import { BASE_MAINNET_VERIFIED } from "@arl/sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import {
  ALLOWANCE_MODULE,
  ECOSYSTEM_SAFE,
  IDENTITY_REGISTRY,
  allowanceLeft,
  runOnce,
} from "../src/index.ts";

const RPC = process.env.RPC ?? "http://127.0.0.1:18547";
const chain = { ...base, rpcUrls: { default: { http: [RPC] } } };
// The Base chain config adds OP Stack formatters that the SDK types do not carry; same client.
const pub = createPublicClient({ chain, transport: http(RPC) }) as unknown as PublicClient;
const token = BASE_MAINNET_VERIFIED.token as Address;
const jobs = BASE_MAINNET_VERIFIED.jobs as Address;

const rpc = (method: string, params: unknown[]) =>
  fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

const fresh = async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [account.address, "0xDE0B6B3A7640000"]);
  return account;
};

async function asSafe(to: Address, data: `0x${string}`) {
  await rpc("anvil_impersonateAccount", [ECOSYSTEM_SAFE]);
  await rpc("anvil_setBalance", [ECOSYSTEM_SAFE, "0xDE0B6B3A7640000"]);
  const w = createWalletClient({ account: ECOSYSTEM_SAFE, chain, transport: http(RPC) });
  const hash = await w.sendTransaction({ to, data });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`Safe call to ${to} reverted`);
}

const safeAbi = parseAbi([
  "function enableModule(address module)",
  "function isModuleEnabled(address module) view returns (bool)",
]);
const moduleAbi = parseAbi([
  "function addDelegate(address delegate)",
  "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
]);
const registryAbi = parseAbi(["function register(string agentURI) returns (uint256)"]);
const jobsAbi = parseAbi([
  "struct Job { uint256 id; address client; address provider; address evaluator; string description; uint256 budget; uint256 expiredAt; uint8 status; address hook; }",
  "function getJob(uint256 jobId) view returns (Job)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
]);

const agent = await fresh();
const provider = await fresh();
console.log("fork block", String(await pub.getBlockNumber()));

// What the Safe owners will sign: enable the module, add the agent, allow 5,000 ARL (no reset).
const enabled = await pub.readContract({
  address: ECOSYSTEM_SAFE,
  abi: safeAbi,
  functionName: "isModuleEnabled",
  args: [ALLOWANCE_MODULE],
});
if (!enabled) {
  await asSafe(
    ECOSYSTEM_SAFE,
    encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [ALLOWANCE_MODULE] }),
  );
}
await asSafe(
  ALLOWANCE_MODULE,
  encodeFunctionData({ abi: moduleAbi, functionName: "addDelegate", args: [agent.address] }),
);
await asSafe(
  ALLOWANCE_MODULE,
  encodeFunctionData({
    abi: moduleAbi,
    functionName: "setAllowance",
    args: [agent.address, token, parseUnits("5000", 18), 0, 0],
  }),
);
console.log("allowance left", String(await allowanceLeft(pub, agent.address, token)));

// A provider lists a service at 40 ARL.
const file = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Rehearsal provider",
  description: "Runs ARL verified-tests jobs.",
  services: [{ name: "web", endpoint: "https://example.org/agent" }],
  x402Support: true,
  active: true,
  arl: {
    version: 1,
    scheme: "upto",
    network: "eip155:8453",
    asset: token,
    unitPrice: parseUnits("40", 18).toString(),
    unit: "job",
    payTo: provider.address,
    facilitator: provider.address,
  },
};
const pw = createWalletClient({ account: provider, chain, transport: http(RPC) });
const reg = await pw.writeContract({
  address: IDENTITY_REGISTRY,
  abi: registryAbi,
  functionName: "register",
  args: [`data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString("base64")}`],
});
await pub.waitForTransactionReceipt({ hash: reg });

const clients = {
  publicClient: pub,
  walletClient: createWalletClient({ account: agent, chain, transport: http(RPC) }),
};
const excluded: Address[] = [ECOSYSTEM_SAFE];

const first = await runOnce(clients, {
  excluded,
  log: (l) => {
    console.log(" run1:", l);
  },
});
const hired = first.opened.find((o) => o.provider === provider.address);
if (!hired)
  throw new Error(`the agent did not hire the provider: ${JSON.stringify(first.skipped)}`);

// The provider asks for its listed price.
const sb = await pw.writeContract({
  address: jobs,
  abi: jobsAbi,
  functionName: "setBudget",
  args: [hired.jobId, parseUnits("40", 18), "0x"],
});
await pub.waitForTransactionReceipt({ hash: sb });

const second = await runOnce(clients, {
  excluded,
  // From here on each run reads only the blocks after the previous run (history.ts).
  history: first.history,
  log: (l) => {
    console.log(" run2:", l);
  },
});
const job = await pub.readContract({
  address: jobs,
  abi: jobsAbi,
  functionName: "getJob",
  args: [hired.jobId],
});
console.log("job", String(hired.jobId), "status", job.status, "budget", String(job.budget));
console.log(
  "funded",
  second.funded.map(String),
  "allowance left",
  String(await allowanceLeft(pub, agent.address, token)),
);

const third = await runOnce(clients, {
  excluded,
  history: second.history,
  log: (l) => {
    console.log(" run3:", l);
  },
});
console.log("third run opened", third.opened.length, "(must be 0: one job per owner)");

const ok = job.status === 1 && second.funded.includes(hired.jobId) && third.opened.length === 0;
console.log(ok ? "REHEARSAL OK" : "REHEARSAL FAILED");
process.exit(ok ? 0 : 1);
