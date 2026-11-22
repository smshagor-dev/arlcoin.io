// One run of ARL's buyer agent on Base Mainnet. Each run is idempotent and reads everything it
// needs from the chain, so it can run from a cron (a Cloudflare Worker) with no database:
//
//   1. finalize: settle its jobs whose verdict is in and whose challenge window has passed, so a
//      provider that did the work is paid before the job's deadline;
//   2. fund: escrow the budget of its jobs whose provider has set one, if it is within the cap;
//   3. hire: open verified jobs with new agents listed on ARL Network (policy.ts decides who).
//
// ARL comes from the Ecosystem & Growth Safe through the Safe AllowanceModule: the agent pulls only
// what a funding needs, and only up to the allowance the Safe owners set. The agent's key holds
// the gas and, at most, the budgets of jobs it is about to fund.

import {
  BASE_MAINNET_VERIFIED,
  finalizeJob,
  openVerifiedJob,
  verifiedEvaluatorAbi,
  type VerifiedClients,
} from "@arl/sdk";
// The spec module only (not the package index, which also loads the Docker runner): Worker-safe.
import { parseSpec, specHash } from "../../verifier/src/spec.ts";
import { getAddress, parseAbi, type Address, type PublicClient } from "viem";

import { emptyHistory, syncHistory, type History } from "./history.ts";
import { DEFAULT_CAPS, planHires, type Caps, type Listing } from "./policy.ts";

export const ECOSYSTEM_SAFE: Address = "0x90D8c082e9AdABE96804Ae9c6117Fd5b245F4cb1";
export const ALLOWANCE_MODULE: Address = "0xAA46724893dedD72658219405185Fb0Fc91e091C";
export const IDENTITY_REGISTRY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
/** ARL Network opened on Base Mainnet at this block (registry scan start). */
export const NETWORK_FROM_BLOCK = 60_877_000n;
/** The agent's history starts here; it has no jobs before this block. */
export const AGENT_FROM_BLOCK = 60_877_000n;
/** The live operator validators: the committee of every job the agent opens. */
export const COMMITTEE: readonly Address[] = [
  "0x7E8e18bf48F07B82F64b846b0d509ad79FD86244",
  "0x394846C9E1161A07471F9e8baEda77E4AEa85fa1",
  "0xdAa1EFD5E765Baf67D8013C1c67039945819B760",
];
/** The work the agent buys: re-run ARL's verified-tests example, pinned to one commit. */
export const SPEC_URI =
  "https://raw.githubusercontent.com/armanalabsai/arlcoin.io/5fb6a52b05488c6967ce979b39b5da08d49499c1/examples/verified-tests/spec.json";

const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const jobsAbi = parseAbi([
  "struct Job { uint256 id; address client; address provider; address evaluator; string description; uint256 budget; uint256 expiredAt; uint8 status; address hook; }",
  "function getJob(uint256 jobId) view returns (Job)",
  "function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
]);
const registryAbi = parseAbi([
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
  "function ownerOf(uint256 agentId) view returns (address)",
]);
export const allowanceModuleAbi = parseAbi([
  "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
  "function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)",
]);

const minBondAbi = parseAbi(["function minBond() view returns (uint96)"]);

const STATUS_OPEN = 0;
const STATUS_COMPLETED = 3;
const PHASE_APPROVED = 2;
const PHASE_REJECTED = 3;

export interface RunOptions {
  /** Addresses never paid: team wallets, Safes, validators. */
  excluded: readonly Address[];
  /** What earlier runs read (history.ts); the run returns the updated one in its report. */
  history?: History | undefined;
  caps?: Caps;
  log?: (line: string) => void;
}

export interface RunReport {
  finalized: bigint[];
  funded: bigint[];
  opened: { jobId: bigint; agentId: bigint; provider: Address; budget: bigint }[];
  skipped: string[];
  /** The history after this run's reads: store it for the next run. */
  history?: History | undefined;
}

const DATA_URI = "data:application/json;base64,";

/** The useful part of an error: the first lines, with the revert reason viem puts there. */
const firstLines = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 3)
    .join(" | ");

/** The ARL terms of a registration file, or undefined when it is not a valid ARL listing. */
export function parseListing(
  uri: string,
  token: Address,
): Omit<Listing, "agentId" | "owner"> | undefined {
  if (!uri.startsWith(DATA_URI) || uri.length > 8192) return undefined;
  try {
    const file = JSON.parse(atob(uri.slice(DATA_URI.length))) as Record<string, unknown>;
    const arl = file.arl as Record<string, unknown> | undefined;
    if (!arl || arl.network !== "eip155:8453") return undefined;
    if (typeof arl.asset !== "string" || getAddress(arl.asset) !== getAddress(token))
      return undefined;
    if (typeof arl.unitPrice !== "string" || !/^\d{1,30}$/.test(arl.unitPrice)) return undefined;
    if (typeof arl.payTo !== "string") return undefined;
    return {
      payTo: getAddress(arl.payTo),
      unitPrice: BigInt(arl.unitPrice),
      active: file.active !== false,
    };
  } catch {
    return undefined;
  }
}

async function listings(
  client: PublicClient,
  token: Address,
  uris: Record<string, string>,
): Promise<Listing[]> {
  const out: Listing[] = [];
  for (const [id, uri] of Object.entries(uris)) {
    const terms = parseListing(uri, token);
    if (!terms) continue;
    const agentId = BigInt(id);
    const owner = await client.readContract({
      address: IDENTITY_REGISTRY,
      abi: registryAbi,
      functionName: "ownerOf",
      args: [agentId],
    });
    out.push({ agentId, owner, ...terms });
  }
  return out;
}

/** One run: finalize, fund, hire. Throws only on a read failure; a failed send is skipped and logged. */
export async function runOnce(clients: VerifiedClients, opts: RunOptions): Promise<RunReport> {
  const { publicClient } = clients;
  const wallet = clients.walletClient;
  const account = wallet.account;
  if (!account) throw new Error("the wallet client has no account");
  const self = account.address;
  const log = opts.log ?? (() => undefined);
  const caps = opts.caps ?? DEFAULT_CAPS;
  const token = BASE_MAINNET_VERIFIED.token as Address;
  const jobsAddr = BASE_MAINNET_VERIFIED.jobs as Address;
  const evaluator = BASE_MAINNET_VERIFIED.evaluator as Address;
  const report: RunReport = { finalized: [], funded: [], opened: [], skipped: [] };
  const skip = (why: string) => {
    report.skipped.push(why);
    log(`skip: ${why}`);
  };

  const head = await publicClient.getBlock();
  const now = head.timestamp;
  // Read only the blocks the stored history has not seen (history.ts); a run without one starts
  // from the agent's first block.
  const history = await syncHistory(
    publicClient,
    opts.history ?? emptyHistory(self, AGENT_FROM_BLOCK),
    IDENTITY_REGISTRY,
    jobsAddr,
    head.number,
  );
  report.history = history;

  // 1 and 2: settle and fund the agent's own jobs.
  for (const entry of history.jobs) {
    if (history.done.includes(entry.jobId)) continue;
    const jobId = BigInt(entry.jobId);
    const job = await publicClient.readContract({
      address: jobsAddr,
      abi: jobsAbi,
      functionName: "getJob",
      args: [jobId],
    });
    const v = await publicClient.readContract({
      address: evaluator,
      abi: verifiedEvaluatorAbi,
      functionName: "getVerdict",
      args: [jobId],
    });
    const unfundedAndExpired = job.status === STATUS_OPEN && job.expiredAt <= now;
    if (
      (job.status >= STATUS_COMPLETED || unfundedAndExpired) &&
      v.phase !== PHASE_APPROVED &&
      v.phase !== PHASE_REJECTED
    ) {
      // Completed, rejected or expired (or never funded before its deadline), and no verdict left
      // to finalize: settled for good.
      history.done.push(entry.jobId);
      continue;
    }
    if ((v.phase === PHASE_APPROVED || v.phase === PHASE_REJECTED) && now >= v.challengeEnds) {
      try {
        await finalizeJob(clients, jobId);
        report.finalized.push(jobId);
        log(`finalized job ${String(jobId)}`);
      } catch (e) {
        skip(`finalize ${String(jobId)}: ${firstLines(e)}`);
      }
      continue;
    }
    if (job.status === STATUS_OPEN && job.budget > 0n && job.expiredAt > now) {
      if (job.budget > caps.maxBudget) {
        skip(`job ${String(jobId)}: budget ${String(job.budget)} is over the cap`);
        continue;
      }
      try {
        await ensureArl(clients, self, token, job.budget);
        const approve = await wallet.writeContract({
          account,
          chain: wallet.chain,
          address: token,
          abi: tokenAbi,
          functionName: "approve",
          args: [jobsAddr, job.budget],
        });
        await publicClient.waitForTransactionReceipt({ hash: approve });
        const fund = await wallet.writeContract({
          account,
          chain: wallet.chain,
          address: jobsAddr,
          abi: jobsAbi,
          functionName: "fund",
          args: [jobId, job.budget, "0x"],
        });
        const r = await publicClient.waitForTransactionReceipt({ hash: fund });
        if (r.status !== "success") throw new Error("fund reverted");
        report.funded.push(jobId);
        log(`funded job ${String(jobId)} with ${String(job.budget)}`);
      } catch (e) {
        skip(`fund ${String(jobId)}: ${firstLines(e)}`);
      }
    }
  }

  // 3: hire new agents.
  const opened = history.jobs.map((j) => ({ provider: j.provider, openedAt: BigInt(j.openedAt) }));
  const spendable =
    (await balance(publicClient, token, self)) + (await allowanceLeft(publicClient, self, token));
  const hires = planHires(
    await listings(publicClient, token, history.uris),
    { self, excluded: opts.excluded, opened, spendable, now },
    caps,
  );
  if (hires.length === 0) return report;

  const specText = await (await fetch(SPEC_URI)).text();
  const hash = specHash(parseSpec(JSON.parse(specText)));
  // The evaluator refuses a bond below its minimum (100 ARL on Base Mainnet); read it, never guess.
  const minBond = await publicClient.readContract({
    address: evaluator,
    abi: minBondAbi,
    functionName: "minBond",
  });
  for (const h of hires) {
    try {
      const { jobId } = await openVerifiedJob(clients, {
        provider: h.listing.payTo,
        specUri: SPEC_URI,
        specHash: hash,
        committee: COMMITTEE,
        threshold: 2,
        bond: minBond,
        providerAgentId: h.listing.agentId,
      });
      report.opened.push({
        jobId,
        agentId: h.listing.agentId,
        provider: h.listing.payTo,
        budget: h.budget,
      });
      log(`opened job ${String(jobId)} with agent ${String(h.listing.agentId)}`);
    } catch (e) {
      skip(`hire agent ${String(h.listing.agentId)}: ${firstLines(e)}`);
    }
  }
  return report;
}

async function balance(client: PublicClient, token: Address, who: Address): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [who],
  });
}

/** What is left of the Safe's allowance for the agent (amount minus spent). */
export async function allowanceLeft(
  client: PublicClient,
  delegate: Address,
  token: Address,
): Promise<bigint> {
  const [amount, spent] = await client.readContract({
    address: ALLOWANCE_MODULE,
    abi: allowanceModuleAbi,
    functionName: "getTokenAllowance",
    args: [ECOSYSTEM_SAFE, delegate, token],
  });
  return amount > spent ? amount - spent : 0n;
}

/** Pulls from the Safe allowance only the shortfall between the agent's balance and `need`. */
async function ensureArl(
  clients: VerifiedClients,
  self: Address,
  token: Address,
  need: bigint,
): Promise<void> {
  const have = await balance(clients.publicClient, token, self);
  if (have >= need) return;
  const wallet = clients.walletClient;
  const account = wallet.account;
  if (!account) throw new Error("the wallet client has no account");
  const hash = await wallet.writeContract({
    account,
    chain: wallet.chain,
    address: ALLOWANCE_MODULE,
    abi: allowanceModuleAbi,
    functionName: "executeAllowanceTransfer",
    // An empty signature means the delegate is the caller (AllowanceModule.recoverSignature).
    args: [
      ECOSYSTEM_SAFE,
      token,
      self,
      need - have,
      "0x0000000000000000000000000000000000000000",
      0n,
      self,
      "0x",
    ],
  });
  const r = await clients.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("allowance transfer reverted");
}
