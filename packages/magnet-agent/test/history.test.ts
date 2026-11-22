import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyHistory, loadHistory } from "../src/history.ts";

const AGENT = "0x00000000000000000000000000000000000A6E7A" as const;
const OTHER = "0x00000000000000000000000000000000000B0B00" as const;

describe("loadHistory", () => {
  it("starts fresh, one block before the start, when nothing is stored", () => {
    const h = loadHistory(undefined, AGENT, 100n);
    assert.deepEqual(h, emptyHistory(AGENT, 100n));
    assert.equal(h.cursor, "99");
  });

  it("keeps a stored history of the same agent", () => {
    const stored = { ...emptyHistory(AGENT, 100n), cursor: "500", uris: { "7": "data:x" } };
    const h = loadHistory(JSON.stringify(stored), AGENT, 100n);
    assert.equal(h.cursor, "500");
    assert.equal(h.uris["7"], "data:x");
  });

  it("starts fresh on damaged JSON, another agent's history or a bad cursor", () => {
    assert.equal(loadHistory("{", AGENT, 100n).cursor, "99");
    assert.equal(loadHistory(JSON.stringify(emptyHistory(OTHER, 5n)), AGENT, 100n).cursor, "99");
    const bad = { ...emptyHistory(AGENT, 100n), cursor: "-1" };
    assert.equal(loadHistory(JSON.stringify(bad), AGENT, 100n).cursor, "99");
  });
});
