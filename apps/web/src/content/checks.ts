// The four checks shown on the home page ("Every job, its own check") and on /checks. Each is
// one template of arl-policy (spec/arl-policy/v0.1.0): the template says what the work is and
// which rules decide it, the policy says who may check it and within which limits. The page
// reads both files at build time (src/site/loadChecks.ts), so the site cannot drift from the
// published format; this module holds only what the files do not say.

import type { Status } from "./types.ts";

export interface CheckIntro {
  /** The policy id: the file name under `templates/` and `policies/`, and the page anchor. */
  readonly policy: string;
  /** The kind of work, as on the home page. */
  readonly title: string;
  /** How this kind of work is proven, in one sentence. */
  readonly how: string;
  /**
   * LIVE: the validators on Base Mainnet run this check today (a re-execution of a pinned
   * container with inputs fetched by hash, packages/verifier). IN DEVELOPMENT: the rules are
   * published and the validator software for them is being built.
   */
  readonly status: Status;
}

export const CHECKS: readonly CheckIntro[] = [
  {
    policy: "code-tests",
    title: "Code",
    how: "Validators run the same test command on the delivered commit, in the same container, and compare the result.",
    status: "LIVE",
  },
  {
    policy: "data-recompute",
    title: "Data analysis",
    how: "Validators fetch the same inputs by their hashes, recompute the analysis and compare every output.",
    status: "LIVE",
  },
  {
    policy: "gpu-inference",
    title: "GPU inference",
    how: "The provider signs what ran on which hardware, and validators re-run a sample of the batch.",
    status: "IN DEVELOPMENT",
  },
  {
    policy: "research-sources",
    title: "Research",
    how: "Validators open every cited source and check that it says what the report claims.",
    status: "IN DEVELOPMENT",
  },
];

export const checkPath = (policy: string): `/${string}` => `/checks#${policy}`;

/** The status of a check by its policy id; throws at build time on an unknown one. */
export function checkStatus(policy: string): Status {
  const check = CHECKS.find((c) => c.policy === policy);
  if (!check) throw new Error(`${policy} is not one of the checks`);
  return check.status;
}

/** Plain words for the evidence kinds a policy requires. */
const EVIDENCE: Readonly<Record<string, string>> = {
  artifact: "The result itself",
  attestation: "A signed attestation of the hardware, model and inputs",
  logs: "The run logs",
  "model-verdict": "The verdict of the pinned model, with its weights hash",
  "result-manifest": "A manifest listing every output with its hash",
};

export function evidenceLabel(kind: string): string {
  const plain = kind.replace(/-/g, " ");
  return EVIDENCE[kind] ?? plain.charAt(0).toUpperCase() + plain.slice(1);
}

/** "1 hour", "48 hours", "10 minutes". */
export function duration(seconds: number): string {
  const [n, unit] = seconds % 3600 === 0 ? [seconds / 3600, "hour"] : [seconds / 60, "minute"];
  return `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
}

/** "1 to 48 hours" for a `[min, max]` window in seconds. */
export function windowRange([min, max]: readonly [number, number]): string {
  const hours = min % 3600 === 0 && max % 3600 === 0;
  if (hours) return `${String(min / 3600)} to ${duration(max)}`;
  return `${duration(min)} to ${duration(max)}`;
}

/** Token amounts in base units to whole tokens: ARL has 18 decimals, USDC 6. */
export function tokenAmount(token: string, baseUnits: string): string {
  const decimals = token === "USDC" ? 6n : 18n;
  const whole = BigInt(baseUnits) / 10n ** decimals;
  return `${whole.toLocaleString("en-US")} ${token}`;
}
