import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  executeAndPublishMeteredReceipt,
  executeAndVoteMeteredJob,
  publishSignedMeteringArtifact,
  readPinnedMeteringArtifact,
  verifyMeteredEvidence,
  voteMeteredJob,
} from "../src/index.ts";

describe("metering public API across the stacked verifier integration", () => {
  it("exposes provider publication and authenticated validator voting", () => {
    assert.equal(typeof executeAndPublishMeteredReceipt, "function");
    assert.equal(typeof publishSignedMeteringArtifact, "function");
    assert.equal(typeof readPinnedMeteringArtifact, "function");
    assert.equal(typeof executeAndVoteMeteredJob, "function");
    assert.equal(typeof verifyMeteredEvidence, "function");
    assert.equal(typeof voteMeteredJob, "function");
  });
});
