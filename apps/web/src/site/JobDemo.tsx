"use client";

import { useState } from "react";

import { SCENARIOS, demoSteps, job1Link } from "@/content/demo.ts";
import type { Balances, Scenario } from "@/content/demo.ts";

const pill =
  "glass-pill inline-flex min-h-11 items-center rounded-full px-5 text-[14px] font-semibold text-fg";
const tag =
  "inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase";
const ext = { rel: "noopener noreferrer", target: "_blank" } as const;

const PLACES: readonly { key: keyof Balances; label: string }[] = [
  { key: "client", label: "Client wallet" },
  { key: "escrow", label: "Escrow contract" },
  { key: "agent", label: "Agent wallet" },
  { key: "bonds", label: "Validator bonds" },
];

/**
 * One verified job, stepped through in the browser. The visitor picks how the agent behaves and
 * moves through the job a step at a time, watching where the money is. Nothing is sent anywhere:
 * the steps come from src/content/demo.ts.
 */
export function JobDemo() {
  const [scenario, setScenario] = useState<Scenario>("honest");
  const [index, setIndex] = useState(0);

  const steps = demoSteps(scenario);
  const current = Math.min(index, steps.length - 1);
  const step = steps[current];
  if (!step) return null;
  const last = current === steps.length - 1;

  return (
    <div className="flex flex-col gap-6">
      <section className="glass flex flex-col gap-4 rounded-[22px] p-6" aria-labelledby="demo-pick">
        <h2 id="demo-pick" className="text-[15px] font-extrabold">
          How does the agent behave?
        </h2>
        <div className="flex flex-wrap gap-3" role="group" aria-labelledby="demo-pick">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`${pill} ${s.id === scenario ? "ring-2 ring-accent" : "opacity-80"}`}
              aria-pressed={s.id === scenario}
              onClick={() => {
                setScenario(s.id);
                setIndex(0);
              }}
              data-testid={`demo-scenario-${s.id}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-[14px] leading-[1.6] text-fg-muted">
          {SCENARIOS.find((s) => s.id === scenario)?.summary}
        </p>
      </section>

      <section
        className="glass flex flex-col gap-5 rounded-[22px] p-6"
        aria-labelledby="demo-step"
        aria-live="polite"
      >
        {/* Two kinds of thing on this card, never mixed: the walkthrough (dashed, grey) and
            what really happened on Base Mainnet (solid, green; see .demo-real below). */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`${tag} border border-dashed border-line text-fg-muted`}
            data-testid="demo-walkthrough-tag"
          >
            Walkthrough · nothing is sent
          </span>
          <p className="font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase">
            Step {current + 1} of {steps.length} · {step.actor}
          </p>
        </div>
        <h2
          id="demo-step"
          className="text-[26px] leading-[1.2] font-bold [overflow-wrap:anywhere]"
          data-testid="demo-title"
        >
          {step.title}
        </h2>
        <p className="text-[16px] leading-[1.6] text-fg-muted">{step.text}</p>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PLACES.map((place) => {
            const amount = step.balances[place.key];
            return (
              <div
                key={place.key}
                className={`flex flex-col gap-1 rounded-[14px] border px-4 py-3 ${
                  amount > 0 ? "border-accent" : "border-line"
                }`}
              >
                <dt className="font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase">
                  {place.label}
                </dt>
                <dd className="text-[20px] font-bold" data-testid={`demo-${place.key}`}>
                  {amount} ARL
                </dd>
              </div>
            );
          })}
        </dl>

        <p className="text-[14px] text-fg-muted">
          Job status on the escrow:{" "}
          <span className="font-semibold text-fg" data-testid="demo-status">
            {step.status}
          </span>
        </p>

        {step.job1 ? (
          <a
            href={job1Link(step.job1)}
            {...ext}
            className="demo-real flex flex-col gap-2 rounded-[14px] px-4 py-3"
            data-testid="demo-real"
          >
            <span className={`${tag} demo-real-tag self-start`}>
              <span aria-hidden="true" className="demo-real-dot" />
              Real · Base Mainnet
            </span>
            <span className="text-[14px] leading-[1.5] text-fg">
              This step happened in job 1. Open its transaction on BaseScan ›
            </span>
          </a>
        ) : (
          <p
            className="rounded-[14px] border border-dashed border-line px-4 py-3 text-[14px] leading-[1.5] text-fg-muted"
            data-testid="demo-only"
          >
            Walkthrough only: there is no transaction for this step in job 1 on Base Mainnet.
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={`${pill} ${current === 0 ? "opacity-50" : ""}`}
            disabled={current === 0}
            onClick={() => {
              setIndex(current - 1);
            }}
            data-testid="demo-back"
          >
            Back
          </button>
          {last ? (
            <button
              type="button"
              className={pill}
              onClick={() => {
                setIndex(0);
              }}
              data-testid="demo-restart"
            >
              Start over
            </button>
          ) : (
            <button
              type="button"
              className={`${pill} ring-2 ring-accent`}
              onClick={() => {
                setIndex(current + 1);
              }}
              data-testid="demo-next"
            >
              Next step
            </button>
          )}
        </div>
      </section>

      <ol className="flex flex-col gap-2 text-[14px]" aria-label="All steps">
        {steps.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`flex w-full items-baseline gap-3 rounded-[12px] border px-4 py-2 text-left ${
                i === current ? "border-accent text-fg" : "border-line text-fg-muted"
              }`}
              aria-current={i === current ? "step" : undefined}
              onClick={() => {
                setIndex(i);
              }}
            >
              <span className="font-mono text-[12px] text-fg-subtle">{i + 1}</span>
              <span className="font-semibold">{s.title}</span>
              <span className="ml-auto hidden text-fg-subtle sm:inline">{s.actor}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
