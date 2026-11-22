import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DOCS, docPath } from "../../src/content/docs.ts";
import { headingSlug, renderDoc } from "../../src/site/renderDoc.ts";

// The documents under /docs link to each other's sections. Every such link must land on a
// heading: the test renders each published document and follows every anchor.

const rendered = new Map<string, string>(DOCS.map((d) => [docPath(d.slug), renderDoc(d)]));
const idsOf = (html: string) =>
  new Set([...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]));

describe("document anchors", () => {
  it("makes the anchor GitHub makes", () => {
    assert.equal(headingSlug("Custody"), "custody");
    assert.equal(headingSlug("Private (anonymous polls)"), "private-anonymous-polls");
    assert.equal(headingSlug("Deployment on Base Mainnet"), "deployment-on-base-mainnet");
    assert.equal(headingSlug("Jobs (ERC-8183)"), "jobs-erc-8183");
    assert.equal(headingSlug("arl-task/1 (v0.1.0)"), "arl-task1-v010");
    assert.equal(headingSlug("What a job costs, and why"), "what-a-job-costs-and-why");
    assert.equal(headingSlug("snake_case stays"), "snake_case-stays");
  });

  it("gives every heading of every document an anchor, unique on its page", () => {
    for (const [path, html] of rendered) {
      if (!html.includes("<h")) continue;
      const all = [...html.matchAll(/<h[1-6]( id="([^"]*)")?/g)];
      const ids = all.map((m) => m[2]);
      assert.ok(
        ids.every((id) => typeof id === "string" && id.length > 0),
        `${path} has a heading without an anchor`,
      );
      assert.equal(new Set(ids).size, ids.length, `${path} repeats an anchor`);
    }
  });

  it("lands every link to a section of a published document on a heading", () => {
    const missing: string[] = [];
    for (const [path, html] of rendered) {
      for (const m of html.matchAll(/<a href="([^"#]*)#([^"]+)"/g)) {
        const [, target, anchor] = m;
        if (target === undefined || anchor === undefined) continue;
        if (/^https?:/.test(target)) continue;
        const page = target === "" ? path : target;
        const html2 = rendered.get(page);
        if (html2 === undefined) continue;
        if (!idsOf(html2).has(anchor)) missing.push(`${path} -> ${page}#${anchor}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});
