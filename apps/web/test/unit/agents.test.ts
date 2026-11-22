import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LISTED_AGENTS, directory, scoreText } from "../../src/content/agents.ts";
import type { GraphAgent } from "../../src/content/agents.ts";
import { ARL_AGENT } from "../../src/content/hire.ts";

const agent = (
  agentId: string,
  completed: number,
  score_bps: number | null = null,
): GraphAgent => ({
  agentId,
  score_bps,
  clients: completed > 0 ? 1 : 0,
  completed,
  rejected: 0,
  expired: 0,
  disputed: 0,
});

describe("agent directory", () => {
  it("lists the ARL agent with its real id, price and hire page", () => {
    assert.equal(LISTED_AGENTS.length, 1);
    const [arl] = LISTED_AGENTS;
    assert.equal(arl?.id, ARL_AGENT.id);
    assert.equal(arl?.from, "100 ARL");
    assert.equal(arl?.hire, "/hire");
  });

  it("shows a listed agent before it has a verified outcome, without a record", () => {
    const entries = directory(LISTED_AGENTS, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, ARL_AGENT.id);
    assert.equal(entries[0]?.record, undefined);
  });

  it("joins a listed agent with its record and adds every other agent of the graph once", () => {
    const graph = [agent("7", 1), agent(ARL_AGENT.id, 2), agent("3", 5), agent("9", 1)];
    const entries = directory(LISTED_AGENTS, graph);
    assert.deepEqual(
      entries.map((e) => e.id),
      [ARL_AGENT.id, "3", "7", "9"],
    );
    assert.equal(entries[0]?.record?.completed, 2);
    assert.ok(entries[0]?.listed);
    assert.equal(entries[1]?.listed, undefined);
  });

  it("gives a score only when the graph has one", () => {
    assert.equal(scoreText(undefined), "After 3 jobs");
    assert.equal(scoreText(agent("1", 2)), "After 3 jobs");
    assert.equal(scoreText(agent("1", 3, 10_000)), "100%");
    assert.equal(scoreText(agent("1", 4, 8750)), "87.5%");
  });
});
