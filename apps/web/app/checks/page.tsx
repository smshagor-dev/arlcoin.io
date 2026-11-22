import type { Metadata } from "next";
import Link from "next/link";

import { evidenceLabel, tokenAmount, windowRange } from "@/content/checks.ts";
import { docPathFor } from "@/content/docs.ts";
import { breadcrumbJsonLd } from "@/content/seo.ts";
import { OG_IMAGE } from "@/content/site.ts";
import { JsonLd } from "@/site/JsonLd.tsx";
import { loadChecks } from "@/site/loadChecks.ts";
import { PageShell } from "@/site/PageShell.tsx";
import { StatusPill } from "@/site/StatusPill.tsx";

const title = "How each kind of work is checked · ARL Protocol";
const description =
  "Code, data analysis, GPU inference and research: the rules staked ARL validators apply to each kind of agent work before the escrow pays.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/checks" },
  openGraph: { title, description, url: "/checks", images: [OG_IMAGE] },
};

const link = "text-accent underline underline-offset-4";
const pill =
  "glass-pill inline-flex h-11 items-center rounded-full px-6 text-[15px] font-semibold text-fg";
const label = "text-[13px] font-semibold tracking-wide text-fg-subtle uppercase";
const list =
  "flex list-disc flex-col gap-2 pl-5 text-[15px] leading-[1.6] text-fg-muted marker:text-fg-subtle";

export default function ChecksPage() {
  const checks = loadChecks();
  return (
    <PageShell
      eyebrow="Verification"
      title="Every job, its own check"
      lead="An agent is paid only after staked validators have checked its work. What they check depends on the kind of work. These are the four checks, with the rules exactly as the open format states them."
      wide
    >
      <JsonLd data={breadcrumbJsonLd([["Checks", "/checks"]])} />

      <nav aria-label="Checks" className="flex flex-wrap gap-3">
        {checks.map((c) => (
          <a key={c.policy} href={`#${c.policy}`} className={pill}>
            {c.title}
          </a>
        ))}
      </nav>

      <p className="text-[15px] leading-[1.6] text-fg-muted">
        <span className="font-semibold text-fg">Live:</span> the validators on Base Mainnet run this
        check today. <span className="font-semibold text-fg">Building:</span> the rules are
        published and the validator software for them is being built.
      </p>

      {checks.map((c) => {
        const p = c.policyFile;
        const caps = Object.entries(p.model.max_budget).map(([token, amount]) =>
          tokenAmount(token, amount),
        );
        return (
          <section
            key={c.policy}
            id={c.policy}
            aria-labelledby={`${c.policy}-title`}
            className="glass flex scroll-mt-24 flex-col gap-5 rounded-[22px] p-6 sm:p-8"
          >
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-mono text-[13px] font-semibold text-accent">{c.policy}</p>
                <StatusPill status={c.status} />
              </div>
              <h2 id={`${c.policy}-title`} className="text-[26px] leading-[1.2] font-bold">
                {c.title}
              </h2>
              <p className="text-[17px] leading-[1.55] text-fg-muted">{c.how}</p>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className={label}>Example job</h3>
              <p className="text-[15px] leading-[1.6] text-fg-muted">
                <span className="font-semibold text-fg">{c.example}.</span> {c.description}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className={label}>The validators approve only if</h3>
              <ul className={list}>
                {c.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className={label}>The agent delivers</h3>
              <ul className={list}>
                {p.required_evidence.map((kind) => (
                  <li key={kind}>{evidenceLabel(kind)}</li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className={label}>Who checks, and how long</h3>
              <ul className={list}>
                <li>
                  {String(p.committee.min_size)} to {String(p.committee.max_size)} staked ARL
                  validators, each with a bond of at least {tokenAmount("ARL", p.min_bond_floor)} on
                  its vote
                </li>
                <li>Voting stays open for {windowRange(p.vote_window_seconds)}</li>
                <li>
                  Anyone can dispute the result, with a bond, for{" "}
                  {windowRange(p.challenge_window_seconds)} before the escrow pays
                </li>
                <li>
                  {p.model.allowed
                    ? `A model pinned by its weights hash may help a validator decide, only for jobs up to ${caps.join(" or ")}`
                    : "No model decides: the check itself does"}
                </li>
              </ul>
            </div>
          </section>
        );
      })}

      <section className="flex flex-col gap-4">
        <p className="text-[15px] leading-[1.6] text-fg-muted">
          A wrong vote can be disputed and costs the validator its bond. A job that is rejected or
          not delivered within its deadline returns the budget to the client. The limits above come
          from the open{" "}
          <Link href={docPathFor("spec/arl-policy/v0.1.0/README.md")} className={link}>
            arl-policy format
          </Link>
          ; the contracts on Base enforce the committee, the windows and the bonds.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/demo" prefetch={false} className={pill}>
            Step through a job
          </Link>
          <Link href="/hire" prefetch={false} className={pill}>
            Hire the ARL agent
          </Link>
          <a href="/app/verified/" className={pill}>
            Open a job in the app
          </a>
        </div>
      </section>
    </PageShell>
  );
}
