// End-to-end simulation of verified jobs against the contracts deployed on Base Mainnet, on a
// local Anvil fork (nothing is sent to Base). Every actor is a fresh address impersonated on the
// fork; no key is involved. Each scenario checks where the money and the bonds end up: an honest
// delivery, a wrong result, an agent that never delivers, a dispute the arbiter overturns, a
// committee that never votes, and a job for the registered ARL agent. Before them, the jobs that
// are open on Base right now are settled on the fork the way they stand.
//
//   anvil --fork-url https://mainnet.base.org --port 18547 --chain-id 8453
//   ARL_FORK_RPC=http://127.0.0.1:18547 npm run simulate:fork
//
// The fork's clock is moved forward by days, so start from a fresh fork each time.
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const say = (line) =>
  process.stdout.write(`${line}
`);
const warn = (line) =>
  process.stderr.write(`${line}
`);

const RPC = process.env.ARL_FORK_RPC;
if (!RPC) {
  warn("set ARL_FORK_RPC to a local Anvil fork of Base Mainnet");
  process.exit(2);
}
const abiOf = (n) =>
  JSON.parse(readFileSync(new URL(`../contracts/out/${n}.sol/${n}.json`, import.meta.url), "utf8"))
    .abi;
const JOBS_ABI = abiOf("ARLJobs");
const EVAL_ABI = abiOf("ARLVerifiedEvaluator");
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);

const ARL = "0xde91E6f39D50bBd875f831dcc1134A3D7f3aaDb4";
const JOBS = "0x9aE99bF9a59aF47E81346B7c0b93Cd2B610455fC";
const EVAL = "0x0D160C869bd2a7AaEDd29e11fc60fdAEf21c3E28";
const COMMUNITY_SAFE = "0xfF12597A671ebAF0cAe37999EE659e03c4f444B5";
const AGENT_ACCOUNT = "0x69CF9b31076E6d4F581A79045eBAbc624E3cd4bf";
const AGENT_ID = 1221687n;
const ONE = 10n ** 18n;
const BUDGET = 100n * ONE;
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const PHASE = [
  "None",
  "Configured",
  "Approved",
  "Rejected",
  "Disputed",
  "Finalized",
  "Released",
  "Failed",
];

const transport = http(RPC, { timeout: 120_000 });
const reader = createPublicClient({ chain: base, transport });
const rpc = (method, params = []) => reader.request({ method, params });
const fees = { maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 1_000_000n };

const fresh = () => privateKeyToAccount(generatePrivateKey()).address;
async function as(address) {
  await rpc("anvil_impersonateAccount", [address]);
  await rpc("anvil_setBalance", [address, toHex(parseEther("1"))]);
  return createWalletClient({ account: address, chain: base, transport });
}
async function send(from, address, abi, functionName, args = []) {
  const wallet = await as(from);
  const hash = await wallet.writeContract({ address, abi, functionName, args, ...fees });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}
async function fails(from, address, abi, functionName, args = []) {
  try {
    await reader.simulateContract({ account: from, address, abi, functionName, args });
    return false;
  } catch {
    return true;
  }
}
const read = (address, abi, functionName, args = []) =>
  reader.readContract({ address, abi, functionName, args });
const bal = (who) => read(ARL, ERC20, "balanceOf", [who]);
const now = async () => Number((await reader.getBlock()).timestamp);
async function warpTo(ts) {
  await rpc("anvil_setNextBlockTimestamp", [toHex(ts)]);
  await rpc("evm_mine");
}
const arl = (wei) => `${(Number(wei / 10n ** 14n) / 10_000).toString()} ARL`;

const results = [];
const check = (scenario, what, ok, detail = "") => {
  results.push({ scenario, what, ok });
  say(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` (${detail})` : ""}`);
};

async function give(to, amount) {
  await send(COMMUNITY_SAFE, ARL, ERC20, "transfer", [to, amount]);
}

async function makeValidators() {
  const vs = [fresh(), fresh(), fresh()];
  for (const v of vs) {
    await give(v, 300n * ONE);
    await send(v, ARL, ERC20, "approve", [EVAL, 300n * ONE]);
    await send(v, EVAL, EVAL_ABI, "stake", [300n * ONE]);
  }
  return vs;
}

/** Opens, configures and funds a verified job; returns its id and actors. */
async function openJob({ provider, agentId = 0n, committee }) {
  const client = fresh();
  await give(client, BUDGET);
  const t = await now();
  const expiredAt = BigInt(t + 7200 + 2 * 86_400 + 3600);
  const spec = keccak256(toHex(`spec ${Math.random()}`));
  const before = await read(JOBS, JOBS_ABI, "jobCounter");
  await send(client, JOBS, JOBS_ABI, "createJob", [
    provider,
    EVAL,
    expiredAt,
    "https://example.org/spec.json",
    "0x0000000000000000000000000000000000000000",
  ]);
  const jobId = await read(JOBS, JOBS_ABI, "jobCounter");
  if (jobId !== before + 1n) throw new Error("job counter did not advance by one");
  await send(client, EVAL, EVAL_ABI, "configure", [
    jobId,
    {
      tier: 1,
      threshold: 2,
      voteWindow: 7200n,
      challengeWindow: 86_400n,
      bond: 100n * ONE,
      providerAgentId: agentId,
      specHash: spec,
      committee,
    },
  ]);
  await send(client, JOBS, JOBS_ABI, "setBudget", [jobId, BUDGET, "0x"]);
  await send(client, ARL, ERC20, "approve", [JOBS, BUDGET]);
  await send(client, JOBS, JOBS_ABI, "fund", [jobId, BUDGET, "0x"]);
  return { jobId, client, expiredAt };
}

async function acceptAll(jobId, provider, committee) {
  await send(provider, EVAL, EVAL_ABI, "approveCommittee", [jobId]);
  for (const v of committee) await send(v, EVAL, EVAL_ABI, "accept", [jobId]);
}
const statusOf = async (jobId) =>
  STATUS[Number((await read(JOBS, JOBS_ABI, "getJob", [jobId])).status)];
const phaseOf = async (jobId) =>
  PHASE[Number((await read(EVAL, EVAL_ABI, "getVerdict", [jobId])).phase)];
const locked = async (vs) =>
  (await Promise.all(vs.map((v) => read(EVAL, EVAL_ABI, "lockedOf", [v])))).reduce(
    (a, b) => a + b,
    0n,
  );
const staked = async (vs) =>
  (await Promise.all(vs.map((v) => read(EVAL, EVAL_ABI, "stakeOf", [v])))).reduce(
    (a, b) => a + b,
    0n,
  );

// ----------------------------------------------------------------------------------------------
const chainId = await reader.getChainId();
const version = await rpc("web3_clientVersion").catch(() => "");
if (chainId !== 8453 || !String(version).toLowerCase().includes("anvil")) {
  warn("this simulation runs only on a local Anvil fork of Base Mainnet");
  process.exit(2);
}
const head = await reader.getBlockNumber();
say(`fork of chain ${chainId} at block ${head}; escrow ${JOBS}, evaluator ${EVAL}`);
if ((await reader.getCode({ address: EVAL })) === undefined)
  throw new Error("no evaluator code on the fork");
const arbiter = await read(EVAL, EVAL_ABI, "arbiter");
const minBond = await read(EVAL, EVAL_ABI, "minBond");
say(`arbiter ${arbiter}, minimum bond ${arl(minBond)}`);
const escrowStart = await bal(JOBS);
const evalStart = await bal(EVAL);

// The jobs open on Base right now, first: an approved one is finalized on the fork once its
// challenge window ends, as a validator's watcher does on Base, before this simulation's clock
// moves past its deadline.
let paidOut = 0n;
{
  const S = "0 live jobs";
  const count = await read(JOBS, JOBS_ABI, "jobCounter");
  say(`\n${S}: ${count.toString()} job(s) on the escrow`);
  for (let jobId = 1n; jobId <= count; jobId++) {
    const job = await read(JOBS, JOBS_ABI, "getJob", [jobId]);
    const v = await read(EVAL, EVAL_ABI, "getVerdict", [jobId]);
    say(
      `  job ${jobId.toString()}: ${STATUS[Number(job.status)]}, verdict ${PHASE[Number(v.phase)]}`,
    );
    if (PHASE[Number(v.phase)] !== "Approved") continue;
    say(
      `    window ends ${new Date(Number(v.challengeEnds) * 1000).toISOString()}, deadline ${new Date(Number(job.expiredAt) * 1000).toISOString()}`,
    );
    if ((await now()) <= Number(v.challengeEnds)) await warpTo(Number(v.challengeEnds) + 1);
    const before = await bal(job.provider);
    await send(fresh(), EVAL, EVAL_ABI, "finalize", [jobId]);
    const paid = (await bal(job.provider)) - before;
    paidOut += paid;
    check(
      S,
      `job ${jobId.toString()}: anyone can finalize it and the provider is paid`,
      paid === job.budget,
      arl(paid),
    );
    check(S, `job ${jobId.toString()} is Completed`, (await statusOf(jobId)) === "Completed");
  }
}

const committee = await makeValidators();
say("three fresh validators staked 300 ARL each");
const deliverable = keccak256(toHex("the delivered result"));

// 1. Honest agent: approved, held through the challenge window, paid.
{
  const S = "1 honest";
  say(`\n${S}: delivered, approved by 2 of 3, paid after the challenge window`);
  const provider = fresh();
  const { jobId, client } = await openJob({ provider, committee });
  check(
    S,
    "budget left the client and sits in the escrow",
    (await bal(client)) === 0n && (await statusOf(jobId)) === "Funded",
  );
  check(
    S,
    "a member cannot accept before the provider approves the committee",
    await fails(committee[0], EVAL, EVAL_ABI, "accept", [jobId]),
  );
  await acceptAll(jobId, provider, committee);
  check(S, "three bonds are locked", (await locked(committee)) === 300n * ONE);
  check(
    S,
    "nobody can vote before the work is submitted",
    await fails(committee[0], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]),
  );
  await send(provider, JOBS, JOBS_ABI, "submit", [jobId, deliverable, "0x"]);
  await send(committee[0], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]);
  check(S, "one approval does not decide", (await phaseOf(jobId)) === "Configured");
  await send(committee[1], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]);
  check(S, "two approvals decide: Approved", (await phaseOf(jobId)) === "Approved");
  check(
    S,
    "the third member cannot vote after the decision",
    await fails(committee[2], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]),
  );
  check(
    S,
    "nobody is paid inside the challenge window",
    (await fails(client, EVAL, EVAL_ABI, "finalize", [jobId])) && (await bal(provider)) === 0n,
  );
  const v = await read(EVAL, EVAL_ABI, "getVerdict", [jobId]);
  await warpTo(Number(v.challengeEnds) + 1);
  await send(fresh(), EVAL, EVAL_ABI, "finalize", [jobId]);
  check(
    S,
    "the provider received the whole budget",
    (await bal(provider)) === BUDGET,
    arl(await bal(provider)),
  );
  check(
    S,
    "job Completed, verdict Finalized",
    (await statusOf(jobId)) === "Completed" && (await phaseOf(jobId)) === "Finalized",
  );
  check(
    S,
    "every bond is unlocked and no stake was lost",
    (await locked(committee)) === 0n && (await staked(committee)) === 900n * ONE,
  );
  check(
    S,
    "it cannot be finalized twice",
    await fails(client, EVAL, EVAL_ABI, "finalize", [jobId]),
  );
}

// 2. Wrong result: rejected, the client gets the budget back.
{
  const S = "2 wrong result";
  say(`\n${S}: delivered, rejected by 2 of 3, refunded`);
  const provider = fresh();
  const { jobId, client } = await openJob({ provider, committee });
  await acceptAll(jobId, provider, committee);
  await send(provider, JOBS, JOBS_ABI, "submit", [jobId, deliverable, "0x"]);
  const other = keccak256(toHex("what the validators computed"));
  await send(committee[0], EVAL, EVAL_ABI, "vote", [jobId, false, deliverable, other]);
  await send(committee[1], EVAL, EVAL_ABI, "vote", [jobId, false, deliverable, other]);
  check(S, "two rejections decide: Rejected", (await phaseOf(jobId)) === "Rejected");
  const v = await read(EVAL, EVAL_ABI, "getVerdict", [jobId]);
  await warpTo(Number(v.challengeEnds) + 1);
  await send(fresh(), EVAL, EVAL_ABI, "finalize", [jobId]);
  check(
    S,
    "the client has the whole budget back",
    (await bal(client)) === BUDGET,
    arl(await bal(client)),
  );
  check(S, "the provider received nothing", (await bal(provider)) === 0n);
  check(
    S,
    "job Rejected, bonds unlocked, no stake lost",
    (await statusOf(jobId)) === "Rejected" &&
      (await locked(committee)) === 0n &&
      (await staked(committee)) === 900n * ONE,
  );
}

// 3. Silent agent: never delivers; the client takes the budget back after the deadline.
{
  const S = "3 silent agent";
  say(`\n${S}: accepted, never delivered, refunded after the deadline`);
  const provider = fresh();
  const { jobId, client, expiredAt } = await openJob({ provider, committee });
  await acceptAll(jobId, provider, committee);
  check(
    S,
    "no refund before the deadline",
    await fails(client, JOBS, JOBS_ABI, "claimRefund", [jobId]),
  );
  await warpTo(Number(expiredAt) + 1);
  check(
    S,
    "the provider cannot deliver after the deadline",
    await fails(provider, JOBS, JOBS_ABI, "submit", [jobId, deliverable, "0x"]),
  );
  await send(client, JOBS, JOBS_ABI, "claimRefund", [jobId]);
  check(S, "the client has the whole budget back", (await bal(client)) === BUDGET);
  check(
    S,
    "bonds stay locked until someone releases the job",
    (await locked(committee)) === 300n * ONE,
  );
  await send(fresh(), EVAL, EVAL_ABI, "release", [jobId]);
  check(
    S,
    "after release every bond is unlocked and no stake was lost",
    (await locked(committee)) === 0n && (await staked(committee)) === 900n * ONE,
  );
  check(
    S,
    "job Expired, verdict Released",
    (await statusOf(jobId)) === "Expired" && (await phaseOf(jobId)) === "Released",
  );
}

// 4. Dispute: an approval is challenged and the arbiter overturns it.
{
  const S = "4 dispute";
  say(`\n${S}: approved, challenged, overturned by the arbiter`);
  const provider = fresh();
  const { jobId, client } = await openJob({ provider, committee });
  await acceptAll(jobId, provider, committee);
  await send(provider, JOBS, JOBS_ABI, "submit", [jobId, deliverable, "0x"]);
  await send(committee[0], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]);
  await send(committee[1], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]);
  const challenger = fresh();
  const v = await read(EVAL, EVAL_ABI, "getVerdict", [jobId]);
  await give(challenger, v.bond);
  await send(challenger, ARL, ERC20, "approve", [EVAL, v.bond]);
  check(
    S,
    "the arbiter cannot open the dispute it would rule on",
    await fails(arbiter, EVAL, EVAL_ABI, "dispute", [jobId, deliverable]),
  );
  await send(challenger, EVAL, EVAL_ABI, "dispute", [jobId, keccak256(toHex("evidence"))]);
  check(
    S,
    "the challenger's bond is held, verdict Disputed",
    (await bal(challenger)) === 0n && (await phaseOf(jobId)) === "Disputed",
  );
  check(
    S,
    "a disputed job cannot be finalized",
    await fails(client, EVAL, EVAL_ABI, "finalize", [jobId]),
  );
  check(
    S,
    "only the arbiter rules",
    await fails(challenger, EVAL, EVAL_ABI, "resolve", [jobId, false, deliverable]),
  );
  const sink = await read(EVAL, EVAL_ABI, "SLASH_SINK");
  const sinkBefore = await bal(sink);
  await send(arbiter, EVAL, EVAL_ABI, "resolve", [jobId, false, keccak256(toHex("ruling"))]);
  check(S, "the client has the whole budget back", (await bal(client)) === BUDGET);
  check(S, "the provider received nothing", (await bal(provider)) === 0n);
  check(S, "the challenger has its bond back", (await bal(challenger)) === v.bond);
  const lost = 900n * ONE - (await staked(committee));
  check(
    S,
    "the two members who approved lost their bonds",
    lost === 2n * v.bond,
    `${arl(lost)} slashed`,
  );
  check(S, "the slashed ARL went to the sink", (await bal(sink)) - sinkBefore === lost);
  check(S, "nothing stays locked", (await locked(committee)) === 0n);
  // Top the two slashed members back up for the scenarios that follow.
  for (const m of committee) {
    const s = await read(EVAL, EVAL_ABI, "stakeOf", [m]);
    if (s < 300n * ONE) {
      await give(m, 300n * ONE - s);
      await send(m, ARL, ERC20, "approve", [EVAL, 300n * ONE - s]);
      await send(m, EVAL, EVAL_ABI, "stake", [300n * ONE - s]);
    }
  }
}

// 5. Nobody votes: the window closes undecided.
{
  const S = "5 no votes";
  say(`\n${S}: delivered, the committee never votes`);
  const provider = fresh();
  const { jobId, client } = await openJob({ provider, committee });
  await acceptAll(jobId, provider, committee);
  await send(provider, JOBS, JOBS_ABI, "submit", [jobId, deliverable, "0x"]);
  await send(fresh(), EVAL, EVAL_ABI, "startVoting", [jobId]);
  const v = await read(EVAL, EVAL_ABI, "getVerdict", [jobId]);
  check(
    S,
    "it cannot be closed while the vote window is open",
    await fails(client, EVAL, EVAL_ABI, "closeUndecided", [jobId]),
  );
  await warpTo(Number(v.voteEnds) + 1);
  const before = await staked(committee);
  await send(fresh(), EVAL, EVAL_ABI, "closeUndecided", [jobId]);
  check(S, "the client has the whole budget back", (await bal(client)) === BUDGET);
  check(S, "the provider received nothing", (await bal(provider)) === 0n);
  const lost = before - (await staked(committee));
  check(
    S,
    "the three members who accepted and did not vote lost their bonds",
    lost === 300n * ONE,
    `${arl(lost)} slashed`,
  );
  check(S, "nothing stays locked", (await locked(committee)) === 0n);
}

// 6. The registered ARL agent: an approval reaches its record.
{
  const S = "6 registered agent";
  say(`\n${S}: a job for ERC-8004 agent ${AGENT_ID} by its owner account`);
  for (const m of committee) {
    const s = await read(EVAL, EVAL_ABI, "stakeOf", [m]);
    if (s < 300n * ONE) {
      await give(m, 300n * ONE - s);
      await send(m, ARL, ERC20, "approve", [EVAL, 300n * ONE - s]);
      await send(m, EVAL, EVAL_ABI, "stake", [300n * ONE - s]);
    }
  }
  const stranger = fresh();
  const wrong = await openJob({ provider: stranger, agentId: AGENT_ID, committee }).then(
    async ({ jobId }) => fails(stranger, EVAL, EVAL_ABI, "approveCommittee", [jobId]),
    () => true,
  );
  check(S, "a provider that does not own the agent cannot take a job in its name", wrong);
  const [okBefore] = await read(EVAL, EVAL_ABI, "outcomesOf", [AGENT_ID]);
  const agentBefore = await bal(AGENT_ACCOUNT);
  const { jobId } = await openJob({ provider: AGENT_ACCOUNT, agentId: AGENT_ID, committee });
  await acceptAll(jobId, AGENT_ACCOUNT, committee);
  await send(AGENT_ACCOUNT, JOBS, JOBS_ABI, "submit", [jobId, deliverable, "0x"]);
  await send(committee[0], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]);
  await send(committee[1], EVAL, EVAL_ABI, "vote", [jobId, true, deliverable, deliverable]);
  const v = await read(EVAL, EVAL_ABI, "getVerdict", [jobId]);
  await warpTo(Number(v.challengeEnds) + 1);
  await send(fresh(), EVAL, EVAL_ABI, "finalize", [jobId]);
  check(
    S,
    "the agent account received the budget",
    (await bal(AGENT_ACCOUNT)) - agentBefore === BUDGET,
  );
  const [okAfter] = await read(EVAL, EVAL_ABI, "outcomesOf", [AGENT_ID]);
  check(
    S,
    "the agent's approved count went up by one",
    okAfter === okBefore + 1n,
    `${okBefore} -> ${okAfter}`,
  );
}

// Accounting across everything above.
{
  const S = "accounting";
  say(`\n${S}`);
  check(
    S,
    "the escrow paid out exactly the live jobs it finalized and kept nothing of the simulated ones",
    escrowStart - (await bal(JOBS)) === paidOut,
    `${arl(escrowStart)} -> ${arl(await bal(JOBS))}`,
  );
  const stakes = await staked(committee);
  check(
    S,
    "the evaluator gained exactly the stakes of the simulated validators",
    (await bal(EVAL)) - evalStart === stakes,
    `+${arl((await bal(EVAL)) - evalStart)}`,
  );
}

const failed = results.filter((r) => !r.ok);
say(`\n${results.length - failed.length} of ${results.length} checks passed`);
for (const f of failed) say(`FAILED: ${f.scenario}: ${f.what}`);
process.exit(failed.length === 0 ? 0 : 1);
