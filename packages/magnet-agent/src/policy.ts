// Who ARL's buyer agent hires, and how much it may spend. Pure: the caller reads the chain and
// passes the facts in; nothing here signs or sends anything.
//
// The caps are what keep the agent safe to run unattended. A service listed on ARL Network is
// untrusted (anyone can register one), so every rule below limits what a dishonest listing, or a
// stolen agent key, can take: one paid job per provider owner, a few jobs a day, a small budget per
// job, and never more than the allowance the Ecosystem & Growth Safe has granted.

import { getAddress, type Address } from "viem";

export interface Listing {
  agentId: bigint;
  /** Owner of the ERC-8004 agent (the provider's wallet). */
  owner: Address;
  /** Who is paid (the listing's payTo). */
  payTo: Address;
  /** Price of one unit in ARL base units. */
  unitPrice: bigint;
  active: boolean;
}

export interface Caps {
  /** Most jobs opened in one UTC day. */
  maxJobsPerDay: number;
  /** Most budget for one job, in ARL base units. */
  maxBudget: bigint;
  /** Least budget worth a job, in ARL base units. */
  minBudget: bigint;
  /** Most jobs ever opened with the same provider owner. */
  maxJobsPerOwner: number;
}

export const DEFAULT_CAPS: Caps = {
  maxJobsPerDay: 10,
  maxBudget: 100n * 10n ** 18n,
  minBudget: 5n * 10n ** 18n,
  maxJobsPerOwner: 1,
};

export interface State {
  /** The agent's own address: never hired. */
  self: Address;
  /** Addresses the agent must never pay (team wallets, Safes, validators). */
  excluded: readonly Address[];
  /** Jobs the agent already opened, with the provider they named. */
  opened: readonly { provider: Address; openedAt: bigint }[];
  /** ARL the agent can still spend: its balance plus what is left of the allowance. */
  spendable: bigint;
  /** Now, in seconds (chain time). */
  now: bigint;
}

export interface Hire {
  listing: Listing;
  budget: bigint;
}

const DAY = 86_400n;
const key = (a: Address) => getAddress(a);

/** The listings to hire now, in agent-number order, within every cap. */
export function planHires(
  listings: readonly Listing[],
  s: State,
  caps: Caps = DEFAULT_CAPS,
): Hire[] {
  const blocked = new Set([s.self, ...s.excluded].map(key));
  const perOwner = new Map<Address, number>();
  for (const o of s.opened) perOwner.set(key(o.provider), (perOwner.get(key(o.provider)) ?? 0) + 1);
  const dayStart = s.now - (s.now % DAY);
  let today = s.opened.filter((o) => o.openedAt >= dayStart).length;
  let left = s.spendable;

  const hires: Hire[] = [];
  const seen = new Set<Address>();
  for (const l of [...listings].sort((a, b) => (a.agentId < b.agentId ? -1 : 1))) {
    if (today >= caps.maxJobsPerDay) break;
    if (!l.active) continue;
    const owner = key(l.owner);
    const payTo = key(l.payTo);
    // One listing per owner per run, and never a team wallet on either side of the listing.
    if (seen.has(owner) || blocked.has(owner) || blocked.has(payTo)) continue;
    if ((perOwner.get(owner) ?? 0) >= caps.maxJobsPerOwner) continue;
    if ((perOwner.get(payTo) ?? 0) >= caps.maxJobsPerOwner) continue;
    const budget = l.unitPrice < caps.maxBudget ? l.unitPrice : caps.maxBudget;
    if (budget < caps.minBudget) continue;
    if (budget > left) break;
    hires.push({ listing: l, budget });
    seen.add(owner);
    left -= budget;
    today += 1;
  }
  return hires;
}
