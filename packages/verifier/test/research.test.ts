import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { builtinPolicy, parseTask, proofHash, taskHash, type Proof } from "@arl/protocol";

import {
  citedSources,
  decideResearch,
  normalize,
  openAiCompatibleJudge,
  pageText,
  parseResearchLog,
  quoteFound,
  type ModelJudge,
  type SourceFetcher,
} from "../src/index.ts";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

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

const SOURCE = "https://example.org/report";
const PAGE = `<html><head><script>var x = "the quote is not here";</script></head><body>
  <p>In 2025 the network settled <b>1,204 verified jobs</b> across three regions,
  according to the operator&rsquo;s annual report.</p></body></html>`;
const QUOTE = "the network settled 1,204 verified jobs across three regions";
const BRIEF = "# Brief\n\nThe network settled 1,204 verified jobs in 2025 [1].\n";

function bundle(over: { quote?: string; brief?: string; page?: string | null } = {}) {
  const brief = over.brief ?? BRIEF;
  const log = JSON.stringify({
    version: "arl-research-log/1",
    sources: [{ id: 1, url: SOURCE, sha256: sha(PAGE), quote: over.quote ?? QUOTE }],
  });
  const proof: Proof = {
    version: "arl-proof/1",
    task_hash: taskHash(task),
    chain_id: 8453,
    jobs: "0x9aE99bF9a59aF47E81346B7c0b93Cd2B610455fC",
    job_id: "7",
    deliverable: {
      uri: "https://example.org/brief.md",
      sha256: sha(brief),
      media_type: "text/markdown",
      bytes: Buffer.byteLength(brief),
    },
    evidence: [
      {
        kind: "artifact",
        uri: "https://example.org/brief.md",
        sha256: sha(brief),
        media_type: "text/markdown",
      },
      {
        kind: "model-verdict",
        uri: "https://example.org/verdict.json",
        sha256: sha("{}"),
        media_type: "application/json",
        model: { name: "open-model", weights_sha256: "a".repeat(64), runtime: "ollama/0.5" },
      },
      {
        kind: "logs",
        uri: "https://example.org/log.json",
        sha256: sha(log),
        media_type: "application/json",
      },
    ],
  };
  const files: Record<string, string | null> = {
    "https://example.org/proof.json": JSON.stringify(proof),
    "https://example.org/brief.md": brief,
    "https://example.org/log.json": log,
    [SOURCE]: over.page === undefined ? PAGE : over.page,
  };
  const fetcher: SourceFetcher = {
    fetch: (url) => {
      const body = files[url];
      return Promise.resolve(
        body === null || body === undefined
          ? { status: 404, body: Buffer.alloc(0) }
          : { status: 200, body: Buffer.from(body, "utf8") },
      );
    },
  };
  return { proof, fetcher };
}

const yes: ModelJudge = { weightsSha256: "b".repeat(64), answers: () => Promise.resolve(true) };

describe("research-sources: text checks", () => {
  it("finds a quote in a page's readable text, not in its scripts", () => {
    assert.equal(quoteFound(PAGE, QUOTE), true);
    assert.equal(quoteFound(PAGE, "the quote is not here at all"), false);
    assert.match(pageText("a&amp;b &#39;c&#39;"), /a&b 'c'/);
    assert.equal(normalize("  The’s  \n Report "), "the's report");
  });

  it("reads citations [n] and ignores markdown links", () => {
    assert.deepEqual(citedSources("A [1]. B [2, 3]. [link](https://x.y) C [1]"), [1, 2, 3]);
  });

  it("refuses a malformed research log", () => {
    assert.throws(() => parseResearchLog({ version: "arl-research-log/1", sources: [] }));
    assert.throws(() =>
      parseResearchLog({
        version: "arl-research-log/1",
        sources: [{ id: 1, url: "http://insecure.example", sha256: "a".repeat(64), quote: QUOTE }],
      }),
    );
  });
});

describe("research-sources: the vote", () => {
  it("approves when every source resolves, every quote is found and the model agrees", async () => {
    const { proof, fetcher } = bundle();
    const d = await decideResearch(
      { task, policy, proofUri: "https://example.org/proof.json", deliverable: proofHash(proof) },
      fetcher,
      yes,
    );
    assert.equal(d.approve, true, d.reason);
    assert.deepEqual(
      d.outcomes.map((o) => [o.id, o.passed, o.by]),
      [
        ["sources-resolve", true, "check"],
        ["claims-supported", true, "check"],
        ["answers-question", true, "model"],
      ],
    );
  });

  it("rejects when the quote is not in the source", async () => {
    const { proof, fetcher } = bundle({ quote: "the network settled ten thousand jobs overnight" });
    const d = await decideResearch(
      { task, policy, proofUri: "https://example.org/proof.json", deliverable: proofHash(proof) },
      fetcher,
      yes,
    );
    assert.equal(d.approve, false);
    assert.match(d.reason, /claims-supported/);
  });

  it("rejects when a cited source does not resolve", async () => {
    const { proof, fetcher } = bundle({ page: null });
    const d = await decideResearch(
      { task, policy, proofUri: "https://example.org/proof.json", deliverable: proofHash(proof) },
      fetcher,
      yes,
    );
    assert.equal(d.approve, false);
    assert.match(d.reason, /sources-resolve/);
  });

  it("rejects without a model for the rule only a model can decide", async () => {
    const { proof, fetcher } = bundle();
    const d = await decideResearch(
      { task, policy, proofUri: "https://example.org/proof.json", deliverable: proofHash(proof) },
      fetcher,
    );
    assert.equal(d.approve, false);
    assert.match(d.reason, /no outcome for rule answers-question/);
  });

  it("rejects a proof that is not the submitted deliverable", async () => {
    const { fetcher } = bundle();
    const d = await decideResearch(
      {
        task,
        policy,
        proofUri: "https://example.org/proof.json",
        deliverable: `0x${"0".repeat(64)}`,
      },
      fetcher,
      yes,
    );
    assert.equal(d.approve, false);
    assert.match(d.reason, /does not hash to the submitted deliverable/);
  });
});

describe("research-sources: the model endpoint", () => {
  const W = "a".repeat(64);
  const task = { title: "t", description: "d" } as Parameters<ModelJudge["answers"]>[0];

  async function withServer(
    fn: (url: string, seen: { auth: string | undefined }[]) => Promise<void>,
  ): Promise<void> {
    const { createServer } = await import("node:http");
    const seen: { auth: string | undefined }[] = [];
    const server = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization });
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "YES" } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      await fn(`http://127.0.0.1:${String(port)}/v1`, seen);
    } finally {
      server.close();
    }
  }

  it("sends a Bearer token when an apiKey is set", async () => {
    await withServer(async (url, seen) => {
      const judge = openAiCompatibleJudge({
        baseUrl: url,
        model: "m",
        weightsSha256: W,
        apiKey: "k1",
      });
      assert.equal(await judge.answers(task, "b"), true);
      assert.equal(seen[0]?.auth, "Bearer k1");
    });
  });

  it("sends no Authorization header without an apiKey", async () => {
    await withServer(async (url, seen) => {
      const judge = openAiCompatibleJudge({ baseUrl: url, model: "m", weightsSha256: W });
      assert.equal(await judge.answers(task, "b"), true);
      assert.equal(seen[0]?.auth, undefined);
    });
  });
});
