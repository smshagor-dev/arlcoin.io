import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseSpec, resultHash, specHash } from "../src/index.ts";

// examples/paid-service is copied out of the repository and run on its own, so nothing there can
// import this package. These are the numbers its README states and its `npm run check` prints.
const example = new URL("../../../examples/paid-service/", import.meta.url);
const SPEC_HASH = "0xd19bf72f563be778f889d5e53d9307e161eee956ba1d98256e6a8818f18ae9e8";
const DELIVERABLE = "0x14314125a6090f687695d2fb06cac04cce830d8a3ec06b9c938ed8ec086efd73";

describe("the paid service example", () => {
  const spec = parseSpec(JSON.parse(readFileSync(new URL("spec.json", example), "utf8")));

  it("ships a spec a validator accepts, with the hash the README states", () => {
    assert.equal(specHash(spec), SPEC_HASH);
    assert.ok(readFileSync(new URL("README.md", example), "utf8").includes(SPEC_HASH));
  });

  it("computes in its own code the deliverable a validator computes for that spec", () => {
    // What the spec's command writes to /out/summary.txt (checked in Docker: `arl-verifier run`).
    const summary = Buffer.from("passed=3 failed=0\n");
    const deliverable = resultHash({
      version: "arl-reexec-result/1",
      spec_hash: specHash(spec),
      exit_code: 0,
      timed_out: false,
      outputs: [
        { path: "summary.txt", sha256: createHash("sha256").update(summary).digest("hex") },
      ],
    });
    assert.equal(deliverable, DELIVERABLE);
    assert.ok(readFileSync(new URL("README.md", example), "utf8").includes(DELIVERABLE));
    // The service returns those same bytes from work().
    assert.ok(
      readFileSync(new URL("server.mjs", example), "utf8").includes('"passed=3 failed=0\\n"'),
    );
  });
});
