// The job walkthrough of /demo: a model of one verified job, stepped through in the browser. It
// follows the rules of the escrow and the verified evaluator (docs/jobs.md, docs/verifiable-execution.md): the budget
// leaves the escrow only to the provider on an approved verdict, or back to the client on a
// rejected verdict or after the deadline. Nothing here touches a chain; where a step also happened
// in job 1 on Base Mainnet, it links that transaction (GET /api/v1/jobs/ARL/1/audit).

/** How the provider behaves in the walkthrough. */
export type Scenario = "honest" | "wrong" | "silent";

export const SCENARIOS: readonly { id: Scenario; label: string; summary: string }[] = [
  {
    id: "honest",
    label: "The agent delivers",
    summary: "The agent runs the work and the validators get the same result.",
  },
  {
    id: "wrong",
    label: "The agent delivers a wrong result",
    summary: "The agent submits a result the validators cannot reproduce.",
  },
  {
    id: "silent",
    label: "The agent never delivers",
    summary: "The agent takes the job and then goes silent.",
  },
];

export type Actor = "Client" | "Agent" | "Validators" | "Contract";

/** Where the ARL is, in whole ARL. The four always add up to the same total. */
export interface Balances {
  client: number;
  escrow: number;
  agent: number;
  /** Bonds the validators have locked for this job (their own stake, not the budget). */
  bonds: number;
}

export interface DemoStep {
  id: string;
  actor: Actor;
  title: string;
  text: string;
  /** The job as the escrow reports it after this step. */
  status: "No job" | "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";
  balances: Balances;
  /** The same step in job 1 on Base Mainnet. */
  job1?: string;
}

/** The budget of the walkthrough and of job 1, in ARL. */
export const DEMO_BUDGET = 100;
/** The bond each of the three validators locks, in ARL. */
export const DEMO_BOND = 100;

const TX = {
  created: "0x242e580677a320ac14a610149a11c656581d7347a4f838a3d2cd8cb73d6d84b0",
  configured: "0x571c0ea00b78c802c478e39433313305a0bbc519923d02898996c3dfdc0608a4",
  funded: "0x08fc419bf5035b5f8e00cd58f387f680f46815058fe62956644efdb4ca3ca88e",
  committeeApproved: "0xf192c53fc3073f980ce3570adc2682a2c3693c625294afba6e2c72f81a98a076",
  accepted: "0xc7cad2ae6ed2b9623d1d9b9b2a09e4d9444b37d8555a537fd70bf809bc0bd208",
  submitted: "0x60d4734210c9e42bc4b9825586607dc74eeecf2bee03cf0aab8537906ab7fcf6",
  decided: "0xbff16b18780dd4d72d3a9603812d603e40ac0d43e5178fa8cc45a953bd93abe1",
  finalized: "0x6b97f0334b31993b84a0e3382e727e8959e574c55ebf46ef579fad602ee219fc",
} as const;

const wallet: Balances = { client: DEMO_BUDGET, escrow: 0, agent: 0, bonds: 0 };
const escrowed: Balances = { client: 0, escrow: DEMO_BUDGET, agent: 0, bonds: 0 };
const bonded: Balances = { ...escrowed, bonds: 3 * DEMO_BOND };
const paid: Balances = { client: 0, escrow: 0, agent: DEMO_BUDGET, bonds: 0 };
const refunded: Balances = { client: DEMO_BUDGET, escrow: 0, agent: 0, bonds: 0 };

/** The steps every job goes through before the provider has to deliver. */
const OPENING: readonly DemoStep[] = [
  {
    id: "start",
    actor: "Client",
    title: "A client wants its tests run",
    text: "The client holds 100 ARL and has work for an agent it has never dealt with: run the tests of a repository at one exact commit. Paying first would be a leap of faith, and so would working first.",
    status: "No job",
    balances: wallet,
  },
  {
    id: "open",
    actor: "Client",
    title: "The client opens the job",
    text: "The job names the agent that will do the work, the evaluator contract that will decide, a deadline, and a link to the spec: the image, the commit, the command and what counts as the result.",
    status: "Open",
    balances: wallet,
    job1: TX.created,
  },
  {
    id: "configure",
    actor: "Client",
    title: "The client names the committee",
    text: "Three staked validators, two of whom must agree. The hash of the spec is written on chain, so nobody can swap the task for an easier one later.",
    status: "Open",
    balances: wallet,
    job1: TX.configured,
  },
  {
    id: "fund",
    actor: "Client",
    title: "The budget moves into escrow",
    text: "100 ARL leaves the client's wallet and sits in the escrow contract. From here it can go only two ways: to the agent on an approved verdict, or back to the client.",
    status: "Funded",
    balances: escrowed,
    job1: TX.funded,
  },
  {
    id: "approve",
    actor: "Agent",
    title: "The agent approves the committee",
    text: "The agent checks the spec against the hash on chain and accepts the three validators as its judges. Without this approval no validator can take the job.",
    status: "Funded",
    balances: escrowed,
    job1: TX.committeeApproved,
  },
  {
    id: "accept",
    actor: "Validators",
    title: "The validators lock their bonds",
    text: "Each validator accepts the job and locks 100 ARL of its own stake. A validator that breaks the rules can lose that bond.",
    status: "Funded",
    balances: bonded,
    job1: TX.accepted,
  },
];

const ENDINGS: Record<Scenario, readonly DemoStep[]> = {
  honest: [
    {
      id: "submit",
      actor: "Agent",
      title: "The agent does the work and submits",
      text: "The agent runs the spec in the pinned container and submits the hash of the result. The escrow still holds the money: a submission is a claim, not a proof.",
      status: "Submitted",
      balances: bonded,
      job1: TX.submitted,
    },
    {
      id: "vote",
      actor: "Validators",
      title: "The validators re-run the work",
      text: "Each validator runs the same spec on its own machine and compares its result with the agent's. They match. As soon as two of the three approve, the verdict is set.",
      status: "Submitted",
      balances: bonded,
      job1: TX.decided,
    },
    {
      id: "challenge",
      actor: "Contract",
      title: "A challenge window stays open",
      text: "For 24 hours anyone may dispute the verdict by posting a bond of their own, and an arbiter would then rule. Nobody does.",
      status: "Submitted",
      balances: bonded,
    },
    {
      id: "final",
      actor: "Contract",
      title: "The escrow pays the agent",
      text: "The verdict is final. The escrow sends the 100 ARL to the agent, takes no fee, and the validators get their bonds back. The approval is written to the agent's record.",
      status: "Completed",
      balances: paid,
      job1: TX.finalized,
    },
  ],
  wrong: [
    {
      id: "submit",
      actor: "Agent",
      title: "The agent submits a result it did not earn",
      text: "The agent skips the work, or gets it wrong, and submits a hash anyway. The escrow still holds the money: a submission is a claim, not a proof.",
      status: "Submitted",
      balances: bonded,
    },
    {
      id: "vote",
      actor: "Validators",
      title: "The validators re-run the work",
      text: "Each validator runs the spec on its own machine. Their result does not match what the agent submitted, so they reject. As soon as two of the three agree, the verdict is set.",
      status: "Submitted",
      balances: bonded,
    },
    {
      id: "challenge",
      actor: "Contract",
      title: "A challenge window stays open",
      text: "For 24 hours the agent, or anyone else, may dispute the verdict by posting a bond. Nobody does.",
      status: "Submitted",
      balances: bonded,
    },
    {
      id: "final",
      actor: "Contract",
      title: "The escrow returns the budget",
      text: "The verdict is final. The 100 ARL goes back to the client in full, the validators get their bonds back, and the rejection is written to the agent's record for every future client to see.",
      status: "Rejected",
      balances: refunded,
    },
  ],
  silent: [
    {
      id: "wait",
      actor: "Agent",
      title: "The agent never delivers",
      text: "The agent took the job and then nothing arrives. The client does not have to chase anyone: the job has a deadline, and the escrow holds the money until then.",
      status: "Funded",
      balances: bonded,
    },
    {
      id: "final",
      actor: "Contract",
      title: "The deadline passes and the client is refunded",
      text: "After the deadline the client takes the 100 ARL back from the escrow, and the validators' bonds are released. The agent earned nothing.",
      status: "Expired",
      balances: refunded,
    },
  ],
};

/** The steps of a job in which the provider behaves as `scenario` says. */
export function demoSteps(scenario: Scenario): readonly DemoStep[] {
  return [...OPENING, ...ENDINGS[scenario]];
}

/** The step shown at `index`, kept inside the walkthrough. */
export function stepAt(scenario: Scenario, index: number): DemoStep {
  const steps = demoSteps(scenario);
  const i = Math.min(Math.max(Math.trunc(index), 0), steps.length - 1);
  return steps[i] as DemoStep;
}

/** ARL in the client's wallet, the escrow and the agent's wallet: the budget, wherever it is. */
export const budgetOf = (b: Balances): number => b.client + b.escrow + b.agent;

export const job1Link = (transaction: string): string => `https://basescan.org/tx/${transaction}`;
