// Validator checks for tasks under arl-policy/1:research-sources (spec/arl-policy/v0.1.0): a
// sourced research brief is not re-executed; each acceptance rule is checked on its own and the
// vote follows decideVote from @arl/protocol (approve only if every rule has an admissible pass).
//
// What the provider publishes (spec/arl-research/v0.1.0): an arl-proof/1 whose deliverable is the
// brief (markdown, citing sources as [1], [2], ...) and whose "logs" evidence is an
// arl-research-log/1 document listing, per source, its URL, the SHA-256 of the bytes the provider
// read and a short verbatim quote that supports the claim it is cited for. The proof's URI goes in
// the third argument of ARLJobs.submit(jobId, proofHash, bytes(proofUri)); the contracts are
// unchanged.
//
// The rules a validator can decide (template spec/arl-policy/v0.1.0/templates/research-sources):
//   sources-resolve   every source cited in the brief is in the log with a content hash, and its
//                     URL answers over https (a deterministic check)
//   claims-supported  each source's quote appears in the text the validator fetched itself
//                     (a deterministic check: no model)
//   answers-question  a pinned open model, when the validator runs one, says the brief answers
//                     the task as asked (a model verdict, admissible only up to the policy's cap)
// Any other rule gets no outcome, so the vote is a reject: a validator never approves a rule it
// did not check.

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";

import {
  builtinPolicy,
  checkProofAgainstTask,
  decideVote,
  parseProof,
  parseTask,
  proofHash,
  taskHash,
  type Policy,
  type Proof,
  type RuleOutcome,
  type Task,
} from "@arl/protocol";
import { decodeFunctionData, hexToString, parseAbi, type Hex, type PublicClient } from "viem";

import { canonicalHash } from "./canonical.ts";

export const RESEARCH_POLICY = "arl-policy/1:research-sources";
export const RESEARCH_LOG_VERSION = "arl-research-log/1";
export const RESEARCH_VOTE_VERSION = "arl-research-vote/1";

/** Limits a validator applies to anything a provider points it at. */
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const MAX_SOURCE_BYTES = 3_000_000;
export const MAX_SOURCES = 32;
export const SOURCE_FETCH_TIMEOUT_MS = 20_000;
const MIN_QUOTE = 20;
const MAX_QUOTE = 1000;

export interface ResearchSource {
  id: number;
  url: string;
  sha256: string;
  quote: string;
}

export interface ResearchLog {
  version: typeof RESEARCH_LOG_VERSION;
  sources: ResearchSource[];
}

export class ResearchError extends Error {
  override name = "ResearchError";
}

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates an untrusted arl-research-log/1 document. Unknown fields are refused. */
export function parseResearchLog(raw: unknown): ResearchLog {
  if (!isRecord(raw)) throw new ResearchError("the research log must be an object");
  for (const k of Object.keys(raw)) {
    if (k !== "version" && k !== "sources") throw new ResearchError(`unknown field ${k}`);
  }
  if (raw.version !== RESEARCH_LOG_VERSION) {
    throw new ResearchError(`version must be ${RESEARCH_LOG_VERSION}`);
  }
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    throw new ResearchError("sources must be a non-empty array");
  }
  if (raw.sources.length > MAX_SOURCES) throw new ResearchError(`at most ${MAX_SOURCES} sources`);
  const seen = new Set<number>();
  const sources = raw.sources.map((s, i): ResearchSource => {
    const what = `sources[${String(i)}]`;
    if (!isRecord(s)) throw new ResearchError(`${what} must be an object`);
    for (const k of Object.keys(s)) {
      if (!["id", "url", "sha256", "quote"].includes(k)) {
        throw new ResearchError(`${what}: unknown field ${k}`);
      }
    }
    if (typeof s.id !== "number" || !Number.isInteger(s.id) || s.id < 1 || s.id > 999) {
      throw new ResearchError(`${what}.id must be an integer from 1 to 999`);
    }
    if (seen.has(s.id)) throw new ResearchError(`source id ${String(s.id)} appears twice`);
    seen.add(s.id);
    if (typeof s.url !== "string") throw new ResearchError(`${what}.url must be a string`);
    let url: URL;
    try {
      url = new URL(s.url);
    } catch {
      throw new ResearchError(`${what}.url is not a URL`);
    }
    if (url.protocol !== "https:") throw new ResearchError(`${what}.url must be https`);
    if (typeof s.sha256 !== "string" || !SHA256.test(s.sha256)) {
      throw new ResearchError(`${what}.sha256 must be 64 lowercase hex`);
    }
    if (
      typeof s.quote !== "string" ||
      normalize(s.quote).length < MIN_QUOTE ||
      s.quote.length > MAX_QUOTE
    ) {
      throw new ResearchError(
        `${what}.quote must be ${String(MIN_QUOTE)} to ${String(MAX_QUOTE)} characters`,
      );
    }
    return { id: s.id, url: s.url, sha256: s.sha256, quote: s.quote };
  });
  return { version: RESEARCH_LOG_VERSION, sources };
}

/** Source numbers a markdown brief cites as [n] (links like [text](url) are not citations). */
export function citedSources(brief: string): number[] {
  const ids = new Set<number>();
  for (const m of brief.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g)) {
    for (const n of (m[1] ?? "").split(",")) ids.add(Number(n.trim()));
  }
  return [...ids].sort((a, b) => a - b);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "-",
  ndash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: "...",
};

/** The readable text of an HTML or plain-text page: no scripts, styles or tags; entities decoded. */
export function pageText(body: string): string {
  return body
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/** Lowercase, typographic quotes and dashes made plain, all whitespace runs as one space. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote appears in the page, both normalized. */
export function quoteFound(page: string, quote: string): boolean {
  return normalize(pageText(page)).includes(normalize(quote));
}

/** What a validator fetches with: bounded, https only, nothing on the validator's own network. */
export interface SourceFetcher {
  fetch(url: string, maxBytes: number): Promise<{ status: number; body: Buffer }>;
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((r) => r.test(ip));
  const v6 = ip.toLowerCase();
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80") ||
    v6.startsWith("::ffff:")
  );
}

/**
 * The default fetcher: https only, the host must not resolve to a private or loopback address,
 * redirects are followed only to https, a deadline and a size cap on every response.
 */
export const networkSourceFetcher: SourceFetcher = {
  async fetch(url, maxBytes) {
    let current = new URL(url);
    for (let hop = 0; hop < 5; hop++) {
      if (current.protocol !== "https:") throw new ResearchError(`${current.href} is not https`);
      const host = current.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host)
        ? [host]
        : (await lookup(host, { all: true })).map((a) => a.address);
      if (addresses.length === 0 || addresses.some(privateAddress)) {
        throw new ResearchError(`${current.hostname} is not a public address`);
      }
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
        headers: { "user-agent": "arl-verifier (research-sources check)" },
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) return { status: res.status, body: Buffer.alloc(0) };
        current = new URL(next, current);
        continue;
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes)
        throw new ResearchError(`${url} is larger than ${String(maxBytes)} bytes`);
      const chunks: Buffer[] = [];
      let total = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          const b = Buffer.from(chunk as Uint8Array);
          total += b.length;
          if (total > maxBytes)
            throw new ResearchError(`${url} is larger than ${String(maxBytes)} bytes`);
          chunks.push(b);
        }
      }
      return { status: res.status, body: Buffer.concat(chunks) };
    }
    throw new ResearchError(`${url} redirects too many times`);
  },
};

/** A pinned open model a validator runs itself, for the rules a model may decide. */
export interface ModelJudge {
  /** SHA-256 of the weights file the validator runs, as recorded in its vote. */
  weightsSha256: string;
  /** True when the brief answers the task as asked. */
  answers(task: Task, brief: string): Promise<boolean>;
}

/**
 * A judge served by a local OpenAI-compatible endpoint (for example Ollama) at temperature 0.
 * The validator states the weights hash of the model it runs; the policy decides whether that
 * model's verdict is admissible.
 */
export function openAiCompatibleJudge(opts: {
  baseUrl: string;
  model: string;
  weightsSha256: string;
}): ModelJudge {
  if (!SHA256.test(opts.weightsSha256)) throw new ResearchError("weightsSha256 must be 64 hex");
  return {
    weightsSha256: opts.weightsSha256,
    async answers(task, brief) {
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(300_000),
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          seed: 0,
          messages: [
            {
              role: "system",
              content:
                "You check research work. Answer with exactly one word: YES if the brief answers the task as asked, NO otherwise.",
            },
            {
              role: "user",
              content: `TASK: ${task.title}\n${task.description}\n\nBRIEF:\n${brief.slice(0, 20_000)}`,
            },
          ],
        }),
      });
      if (!res.ok) throw new ResearchError(`model endpoint answered ${String(res.status)}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = (data.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
      if (text.startsWith("YES")) return true;
      if (text.startsWith("NO")) return false;
      throw new ResearchError("the model gave no YES or NO verdict");
    },
  };
}

/** A research task in a job description, or null when the job is not one (`arl-task:<hash> <uri>`). */
const TASK_DESCRIPTION = /^arl-task:(0x[0-9a-f]{64}) ((?:https|ipfs):\/\/\S+)$/;

export function researchTaskRef(description: string): { hash: Hex; uri: string } | null {
  const m = TASK_DESCRIPTION.exec(description);
  if (!m?.[1] || !m[2]) return null;
  return { hash: m[1] as Hex, uri: m[2] };
}

function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function fetchJson(fetcher: SourceFetcher, url: string, sha256?: string): Promise<unknown> {
  const { status, body } = await fetcher.fetch(url, MAX_DOCUMENT_BYTES);
  if (status !== 200) throw new ResearchError(`${url} answered ${String(status)}`);
  if (sha256 !== undefined && sha256Hex(body) !== sha256) {
    throw new ResearchError(`${url} does not match its SHA-256`);
  }
  return JSON.parse(body.toString("utf8")) as unknown;
}

/**
 * The research task behind a job, checked against the hash in its description and against the
 * evaluator's committed specHash (for a task that is not re-executed, the task hash). Null when
 * the job is not a research-sources task.
 */
export async function fetchResearchTask(
  description: string,
  committedSpecHash: Hex,
  fetcher: SourceFetcher,
): Promise<{ task: Task; policy: Policy } | null> {
  const ref = researchTaskRef(description);
  if (!ref) return null;
  const task = parseTask(await fetchJson(fetcher, ref.uri));
  const hash = taskHash(task);
  if (hash !== ref.hash || hash.toLowerCase() !== committedSpecHash.toLowerCase()) {
    throw new ResearchError("the task does not match the job's hashes");
  }
  if (task.verification.policy !== RESEARCH_POLICY) return null;
  const policy = builtinPolicy(task.verification.policy);
  if (!policy) throw new ResearchError("research-sources is not a built-in policy");
  return { task, policy };
}

const submitAbi = parseAbi([
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
]);

/** The proof URI the provider passed as the third argument of its submit call. */
export async function proofUriOf(client: PublicClient, submissionTx: Hex): Promise<string> {
  const tx = await client.getTransaction({ hash: submissionTx });
  let args: readonly unknown[];
  try {
    ({ args } = decodeFunctionData({ abi: submitAbi, data: tx.input }));
  } catch {
    throw new ResearchError("the submission was not a direct ARLJobs.submit call");
  }
  const uri = hexToString(args[2] as Hex).trim();
  if (!/^(https|ipfs):\/\/\S+$/.test(uri)) {
    throw new ResearchError("the submission carries no https or ipfs proof URI");
  }
  return uri;
}

export interface ResearchDecision {
  approve: boolean;
  reason: string;
  /** The vote's evidence: canonical hash of the outcome record. */
  evidence: Hex;
  outcomes: RuleOutcome[];
}

/**
 * Checks a research proof against its task and decides the vote. `deliverable` is the on-chain
 * submission (the proof hash). Network or format problems of the provider's documents are
 * rejects, not retries: a provider that publishes nothing checkable is not approved.
 */
export async function decideResearch(
  input: { task: Task; policy: Policy; proofUri: string; deliverable: Hex },
  fetcher: SourceFetcher,
  judge?: ModelJudge,
): Promise<ResearchDecision> {
  const outcomes: RuleOutcome[] = [];
  const done = (approve: boolean, reason: string): ResearchDecision => ({
    approve,
    reason,
    outcomes,
    evidence: canonicalHash({
      version: RESEARCH_VOTE_VERSION,
      approve,
      reason,
      outcomes: outcomes.map((o) => ({ ...o })),
    }),
  });

  let proof: Proof;
  let brief: string;
  let log: ResearchLog;
  try {
    proof = parseProof(await fetchJson(fetcher, input.proofUri));
    if (proofHash(proof).toLowerCase() !== input.deliverable.toLowerCase()) {
      return done(false, "the proof does not hash to the submitted deliverable");
    }
    checkProofAgainstTask(input.task, proof);
    const d = await fetcher.fetch(proof.deliverable.uri, MAX_DOCUMENT_BYTES);
    if (d.status !== 200 || sha256Hex(d.body) !== proof.deliverable.sha256) {
      return done(false, "the brief is missing or does not match its SHA-256");
    }
    brief = d.body.toString("utf8");
    const logRef = proof.evidence.find((e) => e.kind === "logs");
    if (!logRef) return done(false, "the proof has no research log");
    log = parseResearchLog(await fetchJson(fetcher, logRef.uri, logRef.sha256));
  } catch (e) {
    return done(
      false,
      `the proof cannot be checked: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Fetch every source once; both deterministic rules read the same pages.
  const pages = new Map<number, string | null>();
  for (const s of log.sources) {
    try {
      const { status, body } = await fetcher.fetch(s.url, MAX_SOURCE_BYTES);
      pages.set(s.id, status === 200 ? body.toString("utf8") : null);
    } catch {
      pages.set(s.id, null);
    }
  }
  const cited = citedSources(brief);
  const inLog = new Set(log.sources.map((s) => s.id));

  for (const rule of input.task.acceptance) {
    if (rule.id === "sources-resolve") {
      const passed =
        cited.length > 0 &&
        cited.every((id) => inLog.has(id)) &&
        log.sources.every((s) => pages.get(s.id) !== null);
      outcomes.push({ id: rule.id, passed, by: "check" });
    } else if (rule.id === "claims-supported") {
      const passed = log.sources.every((s) => {
        const page = pages.get(s.id);
        return page !== null && page !== undefined && quoteFound(page, s.quote);
      });
      outcomes.push({ id: rule.id, passed, by: "check" });
    } else if (rule.id === "answers-question" && judge) {
      try {
        const passed = await judge.answers(input.task, brief);
        outcomes.push({ id: rule.id, passed, by: "model", weights_sha256: judge.weightsSha256 });
      } catch {
        // No verdict, no outcome: decideVote rejects a rule without an outcome.
      }
    }
  }
  const vote = decideVote(input.task, input.policy, outcomes);
  return done(vote.approve, vote.reason);
}
