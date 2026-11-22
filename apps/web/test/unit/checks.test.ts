import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CHECKS,
  checkPath,
  duration,
  evidenceLabel,
  tokenAmount,
  windowRange,
} from "../../src/content/checks.ts";
import { checkStatus } from "../../src/content/checks.ts";
import { DOCS } from "../../src/content/docs.ts";

const spec = new URL("../../../../spec/arl-policy/v0.1.0/", import.meta.url);
const json = (folder: string, policy: string) =>
  JSON.parse(readFileSync(new URL(`${folder}/${policy}.json`, spec), "utf8")) as {
    id?: string;
    verification?: { policy: string };
    required_evidence?: string[];
  };

describe("checks page", () => {
  it("shows the four checks of the home page, each with its template and policy", () => {
    assert.deepEqual(
      CHECKS.map((c) => c.policy),
      ["code-tests", "data-recompute", "gpu-inference", "research-sources"],
    );
    for (const c of CHECKS) {
      assert.equal(json("templates", c.policy).verification?.policy, `arl-policy/1:${c.policy}`);
      assert.equal(json("policies", c.policy).id, c.policy);
      assert.equal(checkPath(c.policy), `/checks#${c.policy}`);
    }
  });

  it("the home page cards link to the page, not to a code host", () => {
    const home = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
    for (const c of CHECKS) assert.ok(home.includes(`policy: "${c.policy}"`), c.policy);
    assert.ok(home.includes("href={checkPath(j.policy)}"));
    assert.ok(home.includes("href={docPathFor(st.readme)}"));
    assert.ok(!home.includes("SITE.repository"));
  });

  it("every format on the home page is published under /docs", () => {
    const home = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
    const readmes = [...home.matchAll(/readme: "([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.equal(readmes.length, 5);
    for (const readme of readmes) {
      assert.ok(
        DOCS.some((d) => d.source === readme),
        readme,
      );
      assert.ok(existsSync(new URL(`../../../../${readme}`, import.meta.url)), readme);
    }
  });

  it("marks as Live only the checks the reference validator runs: re-execution", () => {
    // packages/verifier re-executes a pinned container with git and file inputs fetched by hash
    // (arl-reexec/1); attested and model-assisted work are not in it yet.
    assert.deepEqual(
      CHECKS.map((c) => [c.policy, c.status]),
      [
        ["code-tests", "LIVE"],
        ["data-recompute", "LIVE"],
        ["gpu-inference", "IN DEVELOPMENT"],
        ["research-sources", "IN DEVELOPMENT"],
      ],
    );
    for (const c of CHECKS) {
      const classes = (
        JSON.parse(readFileSync(new URL(`policies/${c.policy}.json`, spec), "utf8")) as {
          workload_classes: string[];
        }
      ).workload_classes;
      assert.equal(c.status === "LIVE", classes.includes("reexec"), c.policy);
      assert.equal(checkStatus(c.policy), c.status);
    }
    assert.throws(() => checkStatus("unknown"));
  });

  it("names every evidence kind the four policies require in plain words", () => {
    for (const c of CHECKS) {
      for (const kind of json("policies", c.policy).required_evidence ?? []) {
        assert.notEqual(evidenceLabel(kind).toLowerCase(), kind.replace(/-/g, " "), kind);
      }
    }
    assert.equal(evidenceLabel("some-new-kind"), "Some new kind");
  });

  it("writes windows and amounts in plain units", () => {
    assert.equal(duration(600), "10 minutes");
    assert.equal(duration(3600), "1 hour");
    assert.equal(windowRange([3600, 172_800]), "1 to 48 hours");
    assert.equal(windowRange([86_400, 259_200]), "24 to 72 hours");
    assert.equal(windowRange([600, 86_400]), "10 minutes to 24 hours");
    assert.equal(tokenAmount("ARL", "100000000000000000000"), "100 ARL");
    assert.equal(tokenAmount("USDC", "100000000"), "100 USDC");
  });
});
