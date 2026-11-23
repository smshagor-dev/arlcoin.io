import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { gitPublisher } from "../src/publish.ts";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

describe("git publisher", () => {
  it("writes a job's files to their own folder and pushes them", async () => {
    const root = mkdtempSync(join(tmpdir(), "arl-publish-"));
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "data", remote]);
    const work = join(root, "work");
    execFileSync("git", ["clone", remote, work]);
    git(work, "checkout", "-b", "data");
    git(work, "config", "user.name", "test");
    git(work, "config", "user.email", "test@example.org");
    git(work, "commit", "--allow-empty", "-m", "start");
    git(work, "push", "-u", "origin", "data");

    const p = gitPublisher({ dir: work, jobsUri: "https://example.org/jobs/", chainId: 8453 });
    assert.equal(p.baseUri(7n), "https://example.org/jobs/8453-7/");
    await p.publish(7n, { "proof.json": Buffer.from("{}\n"), "brief.md": Buffer.from("# Q\n") });

    assert.equal(readFileSync(join(work, "jobs", "8453-7", "brief.md"), "utf8"), "# Q\n");
    const pushed = execFileSync(
      "git",
      ["--git-dir", remote, "ls-tree", "-r", "--name-only", "data"],
      {
        encoding: "utf8",
      },
    );
    assert.match(pushed, /jobs\/8453-7\/proof\.json/);
    await assert.rejects(p.publish(8n, { "../escape": Buffer.from("x") }), /unsafe file name/);
  });

  it("refuses a jobs URI that is not https", () => {
    assert.throws(() => gitPublisher({ dir: ".", jobsUri: "http://x/", chainId: 1 }));
  });
});
