// The agent directory (/agents): agents that can be hired through ARL and agents with verified
// work, read from Base Mainnet when the page opens. Nothing here states what an agent has done;
// that comes from the Agent API. This module only names the agents whose service the site can
// link to, and merges them with what the trust graph returns.
import { ARL_AGENT } from "./hire.ts";

/** An agent the site can send a client to, by its ERC-8004 identity. */
export interface ListedAgent {
  readonly id: string;
  /** What it does for a client, in one line. */
  readonly service: string;
  /** Its smallest budget, with the token. */
  readonly from: string;
  /** The page where a client opens a job for it. */
  readonly hire: `/${string}`;
}

export const LISTED_AGENTS: readonly ListedAgent[] = [
  {
    id: ARL_AGENT.id,
    service: "Runs the tests of a repository at an exact commit and delivers the result.",
    from: `${String(ARL_AGENT.minBudget)} ARL`,
    hire: "/hire",
  },
];

/** One agent of `GET /api/v1/graph`: its id and its arl-reputation score fields. */
export interface GraphAgent {
  readonly agentId: string;
  readonly score_bps: number | null;
  readonly clients: number;
  readonly completed: number;
  readonly rejected: number;
  readonly expired: number;
  readonly disputed: number;
}

export interface DirectoryEntry {
  readonly id: string;
  /** Set when the site can send a client to this agent. */
  readonly listed?: ListedAgent;
  /** Set when the trust graph has verified outcomes for it. */
  readonly record?: GraphAgent;
}

/**
 * The directory: the listed agents first, in their order, then every other agent of the trust
 * graph, the one with the most completed jobs first. An agent appears once.
 */
export function directory(
  listed: readonly ListedAgent[],
  graph: readonly GraphAgent[],
): DirectoryEntry[] {
  const byId = new Map(graph.map((a) => [a.agentId, a]));
  const first = listed.map((l) => ({ id: l.id, listed: l, record: byId.get(l.id) }));
  const named = new Set(listed.map((l) => l.id));
  const rest = graph
    .filter((a) => !named.has(a.agentId))
    .sort((a, b) => b.completed - a.completed || Number(BigInt(a.agentId) - BigInt(b.agentId)))
    .map((a) => ({ id: a.agentId, record: a }));
  return [...first, ...rest];
}

/** "100%", or the reason there is no score yet (arl-reputation/1 needs 3 outcomes). */
export function scoreText(record: GraphAgent | undefined): string {
  if (!record || record.score_bps === null) return "After 3 jobs";
  return `${(record.score_bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
