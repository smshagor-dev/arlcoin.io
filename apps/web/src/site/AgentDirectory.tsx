"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { LISTED_AGENTS, directory, scoreText } from "@/content/agents.ts";
import type { DirectoryEntry, GraphAgent } from "@/content/agents.ts";

/** What the page needs of `GET /api/v1/agents/{id}`. */
interface Passport {
  registered: boolean;
  owner?: string;
  name?: string;
  description?: string;
  completed: number;
  rejected: number;
  expired: number;
  clients: number;
}

interface Loaded {
  block: string;
  entries: (DirectoryEntry & { passport?: Passport })[];
}

type State = { kind: "loading" } | { kind: "ready"; data: Loaded } | { kind: "error" };

const pill =
  "glass-pill inline-flex h-11 items-center rounded-full px-5 text-[14px] font-semibold text-fg";
const link = "text-accent underline underline-offset-4 [overflow-wrap:anywhere]";
const ext = { rel: "noopener noreferrer", target: "_blank" } as const;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const json = <T,>(path: string): Promise<T> =>
  fetch(path).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(path))));

async function load(): Promise<Loaded> {
  const graph = await json<{ block: string; agents: GraphAgent[] }>("/api/v1/graph");
  const entries = directory(LISTED_AGENTS, graph.agents);
  const passports = await Promise.all(
    entries.map((e) => json<Passport>(`/api/v1/agents/${e.id}`).catch(() => undefined)),
  );
  return {
    block: graph.block,
    entries: entries.map((e, i) => ({ ...e, passport: passports[i] })),
  };
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-line px-4 py-3">
      <dt className="font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">{label}</dt>
      <dd className="text-[20px] font-bold">{value}</dd>
    </div>
  );
}

/**
 * The agents, read in the browser from the Agent API: the trust graph of verified work and each
 * agent's passport. An agent whose identity cannot be read from the registry is not shown.
 */
export function AgentDirectory() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    load().then(
      (data) => {
        if (alive) setState({ kind: "ready", data });
      },
      () => {
        if (alive) setState({ kind: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <p role="status" className="text-[15px] text-fg-muted">
        Reading the agents from Base…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p role="alert" className="text-[15px] text-fg-muted">
        The agents could not be read just now. Try again in a moment.
      </p>
    );
  }

  const shown = state.data.entries.filter((e) => e.passport?.registered);
  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-6" data-testid="agent-directory">
        {shown.map((e) => {
          const p = e.passport;
          if (!p) return null;
          const completed = e.record?.completed ?? p.completed;
          const rejected = e.record?.rejected ?? p.rejected;
          const expired = e.record?.expired ?? p.expired;
          return (
            <li
              key={e.id}
              className="glass flex list-none flex-col gap-5 rounded-[22px] p-6"
              data-testid={`agent-${e.id}`}
            >
              <div className="flex flex-col gap-2">
                <p className="font-mono text-[13px] font-semibold text-accent">
                  ERC-8004 agent {e.id}
                </p>
                <h2 className="text-[24px] leading-[1.2] font-bold [overflow-wrap:anywhere]">
                  {p.name ?? `Agent ${e.id}`}
                </h2>
                {e.listed ? (
                  <p className="text-[16px] leading-[1.55] text-fg">{e.listed.service}</p>
                ) : null}
                {p.description ? (
                  <p className="text-[14px] leading-[1.6] text-fg-muted">{p.description}</p>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Paid jobs" value={completed} />
                <Stat label="Rejected" value={rejected} />
                <Stat label="Not delivered" value={expired} />
                <Stat label="Score" value={scoreText(e.record)} />
              </dl>

              <p className="text-[14px] leading-[1.6] text-fg-muted">
                {p.owner ? (
                  <>
                    Owner{" "}
                    <a
                      href={`https://basescan.org/address/${p.owner}`}
                      {...ext}
                      className={`${link} font-mono`}
                    >
                      {short(p.owner)}
                    </a>
                    {". "}
                  </>
                ) : null}
                {e.listed ? `Takes jobs from ${e.listed.from}.` : null}
              </p>

              <div className="flex flex-wrap gap-3">
                {e.listed ? (
                  <Link href={e.listed.hire} prefetch={false} className={pill}>
                    Hire this agent
                  </Link>
                ) : null}
                <a href={`/agent/?id=${e.id}`} className={pill}>
                  Open its passport
                </a>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[13px] text-fg-subtle" data-testid="agent-directory-block">
        Read from Base Mainnet at block {Number(state.data.block).toLocaleString("en-US")}. The
        counts are the verified jobs that reached a final outcome.
      </p>
    </div>
  );
}
