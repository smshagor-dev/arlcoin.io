import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { builtinPolicy, parseTask } from "@arl/protocol";

import {
  buildResearchBundle,
  BUNDLE_FILES,
  decideResearch,
  keywords,
  pickQuote,
  writeBrief,
  type ModelJudge,
  type SourceFetcher,
  type SourceFinder,
} from "../src/index.ts";

const task = parseTask(
  JSON.parse(
    readFileSync(
      new URL("../../../spec/arl-policy/v0.1.0/templates/research-sources.json", import.meta.url),
      "utf8",
    ),
  ) as unknown,
);
const policy = builtinPolicy(task.verification.policy);
if (!policy) throw new Error("research-sources policy missing");

const QUESTION = "When did the Base network launch its mainnet?";
const PAGES: Record<string, string> = {
  "https://example.org/base": `<html><body><p>Base is an Ethereum layer 2 network.</p>
    <p>The Base network opened its mainnet to the public in August 2023, after a developer phase.</p>
    <p>See also [1] for the footnotes of this launch article on the mainnet.</p></body></html>`,
  "https://example.org/other": `<html><body><p>Bananas are yellow and rich in potassium, which is good.</p></body></html>`,
  "https://example.org/history": `<html><body><p>Its mainnet launch came on 9 August 2023, when the Base network
    became open to everyone.</p></body></html>`,
};

const finder: SourceFinder = { find: () => Promise.resolve(Object.keys(PAGES)) };
const published: Record<string, Buffer> = {};
const fetcher: SourceFetcher = {
  fetch: (url) => {
    const body = PAGES[url] ?? published[url]?.toString("utf8");
    return Promise.resolve(
      body === undefined
        ? { status: 404, body: Buffer.alloc(0) }
        : { status: 200, body: Buffer.from(body, "utf8") },
    );
  },
};
const judge: ModelJudge = { weightsSha256: "c".repeat(64), answers: () => Promise.resolve(true) };

describe("research desk: writing", () => {
  it("matches sentences by the question's keywords and skips footnote furniture", () => {
    assert.deepEqual(keywords("When did the Base network launch?"), ["base", "network", "launch"]);
    const q = pickQuote(
      QUESTION,
      "Short. The Base network opened its mainnet in August 2023 to all users.",
    );
    assert.equal(q, "The Base network opened its mainnet in August 2023 to all users.");
    assert.equal(
      pickQuote(QUESTION, "Bananas are yellow and rich in potassium, a fine fruit."),
      null,
    );
    assert.equal(writeBrief("Q?", [{ id: 1, quote: "A fact." }]), "# Q?\n\n- A fact. [1]\n");
  });
});

describe("research desk: a bundle the validators approve", () => {
  it("builds brief, log, verdict and proof that pass decideResearch", async () => {
    const baseUri = "https://example.org/job-7/";
    const bundle = await buildResearchBundle({
      task,
      question: QUESTION,
      chainId: 8453,
      jobs: "0x9aE99bF9a59aF47E81346B7c0b93Cd2B610455fC",
      jobId: 7n,
      baseUri,
      finder,
      fetcher,
      judge,
      model: { name: "qwen2.5:1.5b", runtime: "ollama/0.40.17" },
    });
    assert.equal(bundle.answers, true);
    const log = JSON.parse(String(bundle.files[BUNDLE_FILES.log])) as {
      sources: { url: string }[];
    };
    // The banana page shares no keyword with the question, so it is not a source.
    assert.deepEqual(
      log.sources.map((s) => s.url),
      ["https://example.org/base", "https://example.org/history"],
    );
    for (const [name, bytes] of Object.entries(bundle.files)) published[baseUri + name] = bytes;
    const d = await decideResearch(
      {
        task,
        policy,
        proofUri: baseUri + BUNDLE_FILES.proof,
        deliverable: bundle.deliverable,
      },
      fetcher,
      judge,
    );
    assert.equal(d.approve, true, d.reason);
  });
});
