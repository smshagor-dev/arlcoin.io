// The provider's side of arl-policy/1:research-sources (spec/arl-research/v0.1.0): turn a research
// question into a sourced brief that the validators' checks in research.ts can pass.
//
// The desk is extractive on purpose. It finds public sources, takes one verbatim sentence from each
// that matches the question, and cites it as [n]. Every claim in the brief is a quote the source
// contains, so `claims-supported` holds by construction; whether the brief answers the question is
// left to the pinned model (`answers-question`), as the policy says.

import { createHash } from "node:crypto";

import {
  proofHash,
  type EvidenceItem,
  type ModelRef,
  type Proof,
  type Task,
  taskHash,
} from "@arl/protocol";
import type { Address, Hex } from "viem";

import {
  MAX_SOURCE_BYTES,
  RESEARCH_LOG_VERSION,
  ResearchError,
  pageText,
  quoteFound,
  type ModelJudge,
  type ResearchLog,
  type SourceFetcher,
} from "./research.ts";

/** One source the desk read: where, the hash of the bytes it read, and the readable text. */
export interface DeskSource {
  url: string;
  sha256: string;
  text: string;
}

/** Finds candidate source URLs for a question. */
export interface SourceFinder {
  find(question: string, max: number): Promise<string[]>;
}

const STOP = new Set(
  "about after also among been being between both could does each from have into more most much other over such than that their them then there these they this those through under were what when where which while will with would your how many".split(
    " ",
  ),
);

/** The words of a question worth matching: four letters or more, not a stop word. */
export function keywords(question: string): string[] {
  const words = question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))];
}

/** Sentences of readable text, whitespace collapsed; a blank line always ends one. */
export function sentences(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((block) =>
      block
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?\]])\s+(?=[A-Z0-9"“(])/)
        .map((s) => s.trim()),
    )
    .filter((s) => s.length >= 40 && s.length <= 400);
}

/**
 * The readable text of an HTML page with a blank line after every block (paragraph, heading,
 * list item, cell), so a heading is never read as the start of the next sentence. Within a block
 * the text is exactly what `pageText` gives, so a sentence taken from it is still found verbatim.
 */
export function blockText(html: string): string {
  return pageText(
    html
      // Navigation and the table of contents are not part of the article.
      .replace(/<nav(?=[\s>])[\s\S]*?<\/nav>/gi, " ")
      .replace(
        /<\/(p|h[1-6]|li|dt|dd|td|th|div|caption|figcaption|blockquote)>|<br\s*\/?>/gi,
        "$&\n\n",
      ),
  );
}

/**
 * The sentence of a page that best answers the question, or null when no sentence shares a
 * keyword with it. A sentence scores one point per keyword it contains (matched by stem, so
 * "launched" counts for "launch"), more for the question's subject (its first keyword), and more
 * when it carries the kind of fact the question asks for: a year for "when", a number for "how
 * many" or "how much". Earlier sentences win ties: articles state the key facts first.
 */
export function pickQuote(question: string, text: string): string | null {
  const keys = keywords(question).map((k) => k.slice(0, 5));
  if (keys.length === 0) return null;
  const q = question.toLowerCase();
  const wantsYear = /^\s*when\b|\bwhat year\b/.test(q);
  const wantsNumber = /\bhow (many|much)\b/.test(q);
  let best: { s: string; score: number } | null = null;
  let index = -1;
  for (const whole of sentences(text)) {
    index += 1;
    // A footnote marker ([1], [citation needed]) ends the claim: keep the words before it, which
    // still appear in the page exactly as quoted.
    const s = (whole.split("[")[0] ?? "").trim();
    // Markup that leaked into the text (templates, attributes) is not a claim either.
    if (s.length < 40 || /[{}<>|=]/.test(s)) continue;
    // A claim is a whole sentence: headings, contents lines and cut-off fragments are not.
    if (!/[.!?]["”')]?$/.test(s)) continue;
    const stems = new Set(
      (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).map((w) => w.slice(0, 5)),
    );
    const hits = keys.filter((k) => stems.has(k)).length;
    if (hits === 0) continue;
    const subject = keys[0] ?? "";
    let score = hits + (stems.has(subject) ? 1 : 0);
    if (wantsYear && /\b(1[5-9]|20)\d{2}\b/.test(s)) score += 2;
    if (wantsNumber && /\d/.test(s)) score += 1.5;
    // The lead of an article carries its key facts.
    if (index < 12) score += 1;
    if (!best || score > best.score) best = { s, score };
  }
  return best?.s ?? null;
}

/** The brief: the question as its heading, one cited quote per source, in source order. */
export function writeBrief(question: string, quotes: { id: number; quote: string }[]): string {
  const lines = quotes.map((q) => `- ${q.quote} [${String(q.id)}]`);
  return `# ${question}\n\n${lines.join("\n")}\n`;
}

/** Wikipedia's public search API: the first `max` English articles for the question. */
export const wikipediaFinder: SourceFinder = {
  async find(question, max) {
    const api = new URL("https://en.wikipedia.org/w/api.php");
    api.search = new URLSearchParams({
      action: "query",
      list: "search",
      // Keywords search better than a whole question.
      srsearch: keywords(question).join(" ") || question,
      srlimit: String(max),
      format: "json",
    }).toString();
    const res = await fetch(api, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "arl-research-desk (https://arlcoin.io)" },
    });
    if (!res.ok) throw new ResearchError(`Wikipedia search answered ${String(res.status)}`);
    const data = (await res.json()) as { query?: { search?: { title: string }[] } };
    const page = (title: string) =>
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    // The article about the question's subject first (its first keyword), then the search hits.
    const subject = keywords(question)[0];
    const urls = (data.query?.search ?? []).map((r) => page(r.title));
    if (subject) urls.unshift(page(subject.charAt(0).toUpperCase() + subject.slice(1)));
    return [...new Set(urls)].slice(0, max);
  },
};

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Reads up to `max` sources for a question and keeps those with a quote that matches it. */
export async function gatherSources(
  question: string,
  finder: SourceFinder,
  fetcher: SourceFetcher,
  max = 3,
): Promise<{ source: DeskSource; quote: string }[]> {
  const urls = await finder.find(question, max * 2);
  const picked: { source: DeskSource; quote: string }[] = [];
  for (const url of urls) {
    if (picked.length >= max) break;
    const { status, body } = await fetcher.fetch(url, MAX_SOURCE_BYTES).catch(() => ({
      status: 0,
      body: Buffer.alloc(0),
    }));
    if (status !== 200) continue;
    const html = body.toString("utf8");
    const text = blockText(html);
    const quote = pickQuote(question, text);
    // The same check a validator makes, run before the brief is written.
    if (!quote || quote.length < 20 || !quoteFound(html, quote)) continue;
    // Two pages that share a sentence (mirrors, sister articles) add nothing the first did not.
    if (picked.some((p) => p.quote === quote)) continue;
    picked.push({ source: { url, sha256: sha256(body), text }, quote });
  }
  if (picked.length === 0) throw new ResearchError("no source with a matching sentence was found");
  return picked;
}

/** Everything a provider publishes for one research job, by file name, plus the proof hash. */
export interface ResearchBundle {
  files: Record<string, Buffer>;
  proof: Proof;
  /** The on-chain deliverable. */
  deliverable: Hex;
  /** True when the provider's own run of the pinned model judged that the brief answers. */
  answers: boolean;
}

export const BUNDLE_FILES = {
  brief: "brief.md",
  log: "research-log.json",
  verdict: "model-verdict.json",
  proof: "proof.json",
} as const;

/**
 * Builds the brief, the research log, the provider's model verdict and the arl-proof/1 that binds
 * them, for a job on `jobs` (chain `chainId`). `baseUri` is where the files will be published
 * (https, ending in a slash); the proof names each file there with its SHA-256.
 */
export async function buildResearchBundle(args: {
  task: Task;
  question: string;
  chainId: number;
  jobs: Address;
  jobId: bigint;
  baseUri: string;
  finder: SourceFinder;
  fetcher: SourceFetcher;
  judge: ModelJudge;
  model: { name: string; runtime: string };
  maxSources?: number;
}): Promise<ResearchBundle> {
  if (!args.baseUri.startsWith("https://") || !args.baseUri.endsWith("/")) {
    throw new ResearchError("baseUri must be https and end with a slash");
  }
  const found = await gatherSources(args.question, args.finder, args.fetcher, args.maxSources);
  const quotes = found.map((f, i) => ({ id: i + 1, quote: f.quote }));
  const brief = Buffer.from(writeBrief(args.question, quotes), "utf8");
  const log: ResearchLog = {
    version: RESEARCH_LOG_VERSION,
    sources: found.map((f, i) => ({
      id: i + 1,
      url: f.source.url,
      sha256: f.source.sha256,
      quote: f.quote,
    })),
  };
  const logBytes = Buffer.from(`${JSON.stringify(log, null, 2)}\n`, "utf8");
  const answers = await args.judge.answers(args.task, brief.toString("utf8"));
  const modelRef: ModelRef = {
    name: args.model.name,
    weights_sha256: args.judge.weightsSha256,
    runtime: args.model.runtime,
  };
  const verdict = Buffer.from(
    `${JSON.stringify({ rule: "answers-question", answers, model: modelRef }, null, 2)}\n`,
    "utf8",
  );
  const at = (name: string) => `${args.baseUri}${name}`;
  const evidence: EvidenceItem[] = [
    {
      kind: "artifact",
      uri: at(BUNDLE_FILES.brief),
      sha256: sha256(brief),
      media_type: "text/markdown",
    },
    {
      kind: "model-verdict",
      uri: at(BUNDLE_FILES.verdict),
      sha256: sha256(verdict),
      media_type: "application/json",
      model: modelRef,
    },
    {
      kind: "logs",
      uri: at(BUNDLE_FILES.log),
      sha256: sha256(logBytes),
      media_type: "application/json",
    },
  ];
  const proof: Proof = {
    version: "arl-proof/1",
    task_hash: taskHash(args.task),
    chain_id: args.chainId,
    jobs: args.jobs,
    job_id: args.jobId.toString(),
    deliverable: {
      uri: at(BUNDLE_FILES.brief),
      sha256: sha256(brief),
      media_type: "text/markdown",
      bytes: brief.length,
    },
    evidence,
  };
  return {
    files: {
      [BUNDLE_FILES.brief]: brief,
      [BUNDLE_FILES.log]: logBytes,
      [BUNDLE_FILES.verdict]: verdict,
      [BUNDLE_FILES.proof]: Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, "utf8"),
    },
    proof,
    deliverable: proofHash(proof),
    answers,
  };
}
