import { readFileSync } from "node:fs";
import path from "node:path";

import { CHECKS, type CheckIntro } from "@/content/checks.ts";

// Reads the arl-policy templates and policies from the repository at build time, like
// renderDoc: the page shows the rules exactly as the published files state them.

const specDir = path.join(process.cwd(), "..", "..", "spec", "arl-policy", "v0.1.0");

interface Template {
  title: string;
  description: string;
  acceptance: { id: string; rule: string }[];
  verification: { policy: string };
}

interface Policy {
  id: string;
  committee: { min_size: number; max_size: number };
  vote_window_seconds: [number, number];
  challenge_window_seconds: [number, number];
  min_bond_floor: string;
  required_evidence: string[];
  model: { allowed: boolean; max_budget: Record<string, string> };
}

export interface Check extends CheckIntro {
  readonly example: string;
  readonly description: string;
  readonly rules: readonly string[];
  readonly policyFile: Policy;
}

const read = <T>(folder: string, policy: string): T =>
  JSON.parse(
    readFileSync(path.join(/* turbopackIgnore: true */ specDir, folder, `${policy}.json`), "utf8"),
  ) as T;

export function loadChecks(): Check[] {
  return CHECKS.map((intro) => {
    const template = read<Template>("templates", intro.policy);
    const policyFile = read<Policy>("policies", intro.policy);
    if (
      template.verification.policy !== `arl-policy/1:${intro.policy}` ||
      policyFile.id !== intro.policy
    ) {
      throw new Error(`${intro.policy}: the template and the policy do not name each other`);
    }
    return {
      ...intro,
      example: template.title,
      description: template.description,
      rules: template.acceptance.map((a) => a.rule),
      policyFile,
    };
  });
}
