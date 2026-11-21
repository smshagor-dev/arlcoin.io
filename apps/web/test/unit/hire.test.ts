import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ARL_AGENT, hireLink, hireSpec } from "../../src/content/hire.ts";

const REPO = "https://github.com/armanalabsai/arlcoin.io";
const COMMIT = "8a07287a8b7e459cfd64dddfbfe587864847f6d2";

describe("the spec a client hires the ARL agent with", () => {
  it("hashes to the spec the verifier builds and ran in Docker (docs/run-a-provider.md)", () => {
    const built = hireSpec({
      repository: REPO,
      commit: COMMIT,
      directory: "examples/verified-tests",
    });
    assert.equal(built.ok, true);
    if (built.ok) {
      // The pinned hash of packages/verifier/test/make.test.ts.
      assert.equal(
        built.hash,
        "0x5e2d58f31b217799c32a9392abe998836751027704d16a1e8d64e81f91f6d21a",
      );
      assert.ok(built.json.includes('"workdir": "repo/examples/verified-tests"'));
    }
    // Spaces around the link and slashes around the directory change nothing.
    const loose = hireSpec({
      repository: ` ${REPO} `,
      commit: COMMIT,
      directory: "/examples/verified-tests/",
    });
    assert.equal(loose.ok && built.ok && loose.hash === built.hash, true);
  });

  it("runs in the repository root when no directory is given", () => {
    const built = hireSpec({ repository: REPO, commit: COMMIT, directory: "" });
    assert.equal(built.ok && built.json.includes('"workdir": "repo"'), true);
  });

  it("refuses what a validator would refuse", () => {
    assert.equal(
      hireSpec({ repository: "git@github.com:x/y.git", commit: COMMIT, directory: "" }).ok,
      false,
    );
    assert.equal(
      hireSpec({ repository: "http://github.com/x/y", commit: COMMIT, directory: "" }).ok,
      false,
    );
    assert.equal(hireSpec({ repository: REPO, commit: "main", directory: "" }).ok, false);
    assert.equal(
      hireSpec({ repository: REPO, commit: COMMIT.slice(0, 12), directory: "" }).ok,
      false,
    );
    assert.equal(hireSpec({ repository: REPO, commit: COMMIT, directory: "../secrets" }).ok, false);
    assert.equal(hireSpec({ repository: REPO, commit: COMMIT, directory: "a b" }).ok, false);
  });

  it("links to the app's job form filled for the agent", () => {
    const link = hireLink("https://example.com/spec.json");
    assert.ok(link);
    const query = new URL(link, "https://arlcoin.io").searchParams;
    assert.equal(query.get("spec"), "https://example.com/spec.json");
    assert.equal(query.get("provider"), ARL_AGENT.address);
    assert.equal(query.get("agent"), ARL_AGENT.id);
    assert.equal(query.get("budget"), "100");
    assert.equal(hireLink("example.com/spec.json"), null);
  });
});
