"use client";

import { useEffect, useState } from "react";

import { ARL_AGENT } from "@/content/hire.ts";
import { STATUS_CONTRACTS, readStatus } from "@/content/status.ts";
import type { NetworkState } from "@/content/status.ts";

const POLL_MS = 60_000;
const link = "text-accent underline underline-offset-4 [overflow-wrap:anywhere]";
const ext = { rel: "noopener noreferrer", target: "_blank" } as const;
const card = "glass flex flex-col gap-4 rounded-[22px] p-6";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const arl = (wei: string) => (Number(BigInt(wei) / 10n ** 16n) / 100).toLocaleString("en-US");

function Dot({ ok }: { ok: boolean | null }) {
  const tone = ok === null ? "bg-fg-subtle" : ok ? "bg-[#7ee0a6]" : "bg-[#ff8a8a]";
  return (
    <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone}`} />
  );
}

function Line({
  ok,
  name,
  detail,
  testId,
}: {
  ok: boolean | null;
  name: React.ReactNode;
  detail: React.ReactNode;
  testId?: string;
}) {
  return (
    <li
      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-[12px] border border-line px-4 py-3 text-[14px]"
      data-testid={testId}
      data-ok={ok === null ? "checking" : String(ok)}
    >
      <span className="flex items-center gap-3 font-semibold">
        <Dot ok={ok} />
        {name}
      </span>
      <span className="text-fg-muted [overflow-wrap:anywhere]">{detail}</span>
    </li>
  );
}

/**
 * What answers right now, read in the visitor's browser: Base through public endpoints, the six
 * contracts' code, and the Agent API with the validators and the agent it reports. Each line
 * states only what its own answer shows; nothing is cached or reported by the site itself.
 */
export function NetworkStatus() {
  const [state, setState] = useState<NetworkState | null>(null);

  useEffect(() => {
    let stopped = false;
    const check = () => {
      void readStatus().then((next) => {
        if (!stopped) setState(next);
      });
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  const s = state;
  // A contract that could not be asked about is not counted as failing: the chain line says so.
  const parts = s
    ? [s.chain.ok, s.api.ok, ...s.contracts.map((c) => c.ok !== false), s.validators !== null]
    : [];
  const failing = parts.filter((p) => !p).length;

  return (
    <div className="flex flex-col gap-6">
      <p
        role="status"
        className="glass flex items-center gap-3 rounded-[22px] p-6 text-[17px] font-semibold"
        data-testid="status-summary"
      >
        <Dot ok={s ? failing === 0 : null} />
        {!s
          ? "Checking…"
          : failing === 0
            ? "Everything answers."
            : `${String(failing)} of ${String(parts.length)} checks do not answer right now.`}
        {s && (
          <span className="ml-auto font-mono text-[12px] font-normal text-fg-subtle">
            checked {new Date(s.checkedAt).toISOString().slice(11, 19)} UTC
          </span>
        )}
      </p>

      <section className={card} aria-labelledby="status-chain">
        <h2 id="status-chain" className="text-[15px] font-extrabold">
          Base Mainnet
        </h2>
        <ul className="flex flex-col gap-2">
          <Line
            ok={s ? s.chain.ok : null}
            name="Chain"
            detail={
              s?.chain.ok
                ? `block ${s.chain.block.toLocaleString("en-US")}, answered in ${String(s.chain.ms)} ms`
                : s
                  ? "no public endpoint answered"
                  : "checking"
            }
            testId="status-chain-line"
          />
        </ul>
      </section>

      <section className={card} aria-labelledby="status-contracts">
        <h2 id="status-contracts" className="text-[15px] font-extrabold">
          Contracts
        </h2>
        <ul className="flex flex-col gap-2">
          {STATUS_CONTRACTS.map((c, i) => {
            const got = s?.contracts[i];
            return (
              <Line
                key={c.address}
                ok={got ? got.ok : null}
                name={c.name}
                detail={
                  <>
                    <a href={`https://basescan.org/address/${c.address}`} {...ext} className={link}>
                      {short(c.address)}
                    </a>
                    {got
                      ? got.ok === null
                        ? " · not checked"
                        : got.ok
                          ? " · deployed, answering"
                          : " · no code at this address"
                      : ""}
                  </>
                }
                testId="status-contract"
              />
            );
          })}
        </ul>
      </section>

      <section className={card} aria-labelledby="status-api">
        <h2 id="status-api" className="text-[15px] font-extrabold">
          Agent API
        </h2>
        <ul className="flex flex-col gap-2">
          <Line
            ok={s ? s.api.ok : null}
            name="arlcoin.io/api/v1"
            detail={s?.api.ok ? `answered in ${String(s.api.ms)} ms` : s ? "no answer" : "checking"}
            testId="status-api-line"
          />
          <Line
            ok={s ? s.history !== null : null}
            name="Verified history"
            detail={
              s?.history
                ? `read up to block ${s.history.block.toLocaleString("en-US")}${
                    s.history.minutesBehind === null
                      ? ""
                      : `, about ${String(s.history.minutesBehind)} min behind the chain`
                  }`
                : s
                  ? "no answer"
                  : "checking"
            }
            testId="status-history-line"
          />
        </ul>
      </section>

      <section className={card} aria-labelledby="status-validators">
        <h2 id="status-validators" className="text-[15px] font-extrabold">
          Validators
        </h2>
        {s?.validators ? (
          <>
            <p className="text-[14px] leading-[1.6] text-fg-muted">
              {String(s.validators.length)} staked validators,{" "}
              {arl(s.validators.reduce((sum, v) => sum + BigInt(v.stake), 0n).toString())} ARL
              staked in total. Stake and record are read from the evaluator contract.
            </p>
            <ul className="flex flex-col gap-2">
              {s.validators.map((v) => (
                <Line
                  key={`${v.token}-${v.validator}`}
                  ok={BigInt(v.stake) > 0n}
                  name={
                    <a
                      href={`https://basescan.org/address/${v.validator}`}
                      {...ext}
                      className={link}
                    >
                      {short(v.validator)}
                    </a>
                  }
                  detail={`${arl(v.stake)} ${v.token} staked · ${String(v.accepted)} jobs accepted · ${String(v.slashes)} slashes`}
                  testId="status-validator"
                />
              ))}
            </ul>
          </>
        ) : (
          <p className="text-[14px] text-fg-muted">{s ? "The API did not answer." : "Checking…"}</p>
        )}
      </section>

      <section className={card} aria-labelledby="status-agent">
        <h2 id="status-agent" className="text-[15px] font-extrabold">
          {ARL_AGENT.name}
        </h2>
        <ul className="flex flex-col gap-2">
          <Line
            ok={s ? (s.agent?.registered ?? false) : null}
            name={
              <a href={`/agent?id=${ARL_AGENT.id}`} className={link}>
                Agent {ARL_AGENT.id}
              </a>
            }
            detail={
              s?.agent?.registered
                ? `registered on Base · ${String(s.agent.completed)} verified jobs approved, ${String(s.agent.rejected)} rejected`
                : s
                  ? "no answer"
                  : "checking"
            }
            testId="status-agent-line"
          />
        </ul>
      </section>
    </div>
  );
}
