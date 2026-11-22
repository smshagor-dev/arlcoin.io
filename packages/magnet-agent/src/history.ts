// What the buyer agent remembers between runs, so each run reads only the blocks it has not seen.
//
// Base adds about 430,000 blocks a day and public endpoints answer `eth_getLogs` for at most
// 50,000 blocks at a time, so rescanning from the start on every run would grow without end. The
// history holds the last block read (`cursor`), the latest registration file of every ERC-8004
// agent seen, and the agent's own jobs. It is plain JSON (bigints as strings), kept by the runner
// between runs (the GitHub Actions cache). If it is lost, the next run rebuilds it from the start
// block: slower once, never wrong.

import { parseAbi, type Address, type PublicClient } from "viem";

export interface History {
  version: 1;
  agent: Address;
  /** Last block read, inclusive. */
  cursor: string;
  /** agentId → latest registration URI. */
  uris: Record<string, string>;
  /** The agent's jobs, in creation order. */
  jobs: { jobId: string; provider: Address; openedAt: string }[];
  /** Jobs that are settled for good: never read again. */
  done: string[];
}

const registryAbi = parseAbi([
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
]);
const jobsAbi = parseAbi([
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
]);

export function emptyHistory(agent: Address, startBlock: bigint): History {
  return { version: 1, agent, cursor: String(startBlock - 1n), uris: {}, jobs: [], done: [] };
}

/** A stored history for this agent, or a fresh one when it is missing, damaged or another agent's. */
export function loadHistory(text: string | undefined, agent: Address, startBlock: bigint): History {
  if (!text) return emptyHistory(agent, startBlock);
  try {
    const h = JSON.parse(text) as Partial<History> & { version?: unknown };
    if (h.version !== 1 || h.agent?.toLowerCase() !== agent.toLowerCase()) throw new Error("other");
    if (
      typeof h.cursor !== "string" ||
      !/^\d+$/.test(h.cursor) ||
      typeof h.uris !== "object" ||
      !Array.isArray(h.jobs)
    ) {
      throw new Error("shape");
    }
    return {
      version: 1,
      agent,
      cursor: h.cursor,
      uris: h.uris,
      jobs: h.jobs,
      done: Array.isArray(h.done) ? h.done : [],
    };
  } catch {
    return emptyHistory(agent, startBlock);
  }
}

const MAX_SPAN = 50_000n;
const MIN_SPAN = 2_000n;

/**
 * Reads the registry's registrations and the agent's JobCreated events from the block after the
 * cursor up to `head`, in spans the endpoint accepts (halving a span it refuses), and returns the
 * updated history. A span is only recorded once all of its logs are read.
 */
export async function syncHistory(
  client: PublicClient,
  h: History,
  registry: Address,
  jobs: Address,
  head: bigint,
): Promise<History> {
  const next: History = { ...h, uris: { ...h.uris }, jobs: [...h.jobs], done: [...h.done] };
  let from = BigInt(h.cursor) + 1n;
  let span = MAX_SPAN;
  while (from <= head) {
    const to = from + span - 1n < head ? from + span - 1n : head;
    let reg, upd, created;
    try {
      [reg, upd, created] = await Promise.all([
        client.getContractEvents({
          address: registry,
          abi: registryAbi,
          eventName: "Registered",
          fromBlock: from,
          toBlock: to,
        }),
        client.getContractEvents({
          address: registry,
          abi: registryAbi,
          eventName: "URIUpdated",
          fromBlock: from,
          toBlock: to,
        }),
        client.getContractEvents({
          address: jobs,
          abi: jobsAbi,
          eventName: "JobCreated",
          args: { client: h.agent },
          fromBlock: from,
          toBlock: to,
        }),
      ]);
    } catch (e) {
      if (span <= MIN_SPAN) throw e;
      span /= 2n;
      continue;
    }
    for (const log of [...reg, ...upd].sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    )) {
      const id = log.args.agentId;
      const uri = log.eventName === "Registered" ? log.args.agentURI : log.args.newURI;
      if (id !== undefined && uri !== undefined) next.uris[String(id)] = uri;
    }
    for (const ev of created) {
      if (ev.args.jobId === undefined || ev.args.provider === undefined) continue;
      if (next.jobs.some((j) => j.jobId === String(ev.args.jobId))) continue;
      const block = await client.getBlock({ blockNumber: ev.blockNumber });
      next.jobs.push({
        jobId: String(ev.args.jobId),
        provider: ev.args.provider,
        openedAt: String(block.timestamp),
      });
    }
    next.cursor = String(to);
    from = to + 1n;
    if (span < MAX_SPAN) span *= 2n;
  }
  return next;
}
