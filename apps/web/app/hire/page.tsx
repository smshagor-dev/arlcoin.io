import type { Metadata } from "next";
import Link from "next/link";

import { ARL_AGENT } from "@/content/hire.ts";
import { breadcrumbJsonLd } from "@/content/seo.ts";
import { OG_IMAGE } from "@/content/site.ts";
import { HireAgent } from "@/site/HireAgent.tsx";
import { JsonLd } from "@/site/JsonLd.tsx";
import { FactList, PageShell } from "@/site/PageShell.tsx";

const title = "Hire the ARL agent · ARL Protocol";
const description =
  "ARL AIBORG runs your repository's tests at an exact commit. It is paid from escrow only after staked validators re-run them and get the same result.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/hire" },
  openGraph: { title, description, url: "/hire", images: [OG_IMAGE] },
};

const link = "text-accent underline underline-offset-4 [overflow-wrap:anywhere]";

export default function HirePage() {
  return (
    <PageShell
      eyebrow={ARL_AGENT.name}
      title="Hire the ARL agent"
      lead="ARL AIBORG runs your repository's tests at the exact commit you name. Its payment waits in escrow until staked validators have re-run the same tests and reached the same result."
      wide
    >
      <JsonLd data={breadcrumbJsonLd([["Hire the ARL agent", "/hire"]])} />

      <FactList
        title="What you hire"
        items={[
          "The work: one run of your tests with Node's built-in test runner, at one commit, inside a container pinned by digest and without network access.",
          "The result: the runner's summary (tests, passed, failed, skipped) and the exit status. Its hash is recorded on Base, and anyone can re-run the spec and compare.",
          "The check: a committee of staked validators re-runs the job. The job is accepted only when a majority reaches the same result and every test passes.",
          `The price: from ${String(ARL_AGENT.minBudget)} ARL per job, held by the escrow. The escrow takes no fee, and the budget returns to you when the result is rejected or the deadline passes.`,
          <>
            The agent: number {ARL_AGENT.id} in the ERC-8004 identity registry on Base.{" "}
            <Link href={`/agent?id=${ARL_AGENT.id}`} prefetch={false} className={link}>
              Its passport
            </Link>{" "}
            shows every verified job it has done.
          </>,
        ]}
      />

      <HireAgent />

      <FactList
        title="What the run needs"
        items={[
          "Tests that run with node --test from the checkout alone: no install step and no network during the run.",
          "A repository that can be cloned over https, and the full commit id.",
          `A run that finishes within ${String(ARL_AGENT.maxSeconds)} seconds and ${String(ARL_AGENT.maxMemoryMb)} MB of memory.`,
          "A wallet on Base that holds the budget in ARL and a little ETH for gas. The app asks for five confirmations: post the job, name the committee, propose the budget, approve, escrow.",
        ]}
      />
    </PageShell>
  );
}
