import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEMO_BOND,
  DEMO_BUDGET,
  SCENARIOS,
  budgetOf,
  demoSteps,
  stepAt,
} from "../../src/content/demo.ts";

describe("the job walkthrough", () => {
  it("never creates or loses budget, whatever the agent does", () => {
    for (const { id } of SCENARIOS) {
      for (const step of demoSteps(id)) {
        assert.equal(budgetOf(step.balances), DEMO_BUDGET, `${id}/${step.id}`);
        for (const amount of Object.values(step.balances)) assert.ok(amount >= 0);
      }
    }
  });

  it("pays the agent only on an approved verdict", () => {
    const honest = demoSteps("honest");
    const paid = honest.filter((s) => s.balances.agent > 0);
    assert.deepEqual(
      paid.map((s) => s.id),
      ["final"],
    );
    assert.equal(honest.at(-1)?.status, "Completed");
    for (const id of ["wrong", "silent"] as const) {
      const steps = demoSteps(id);
      assert.ok(steps.every((s) => s.balances.agent === 0));
      assert.equal(steps.at(-1)?.balances.client, DEMO_BUDGET);
    }
    assert.equal(demoSteps("wrong").at(-1)?.status, "Rejected");
    assert.equal(demoSteps("silent").at(-1)?.status, "Expired");
  });

  it("holds the budget in escrow from funding until the job ends", () => {
    for (const { id } of SCENARIOS) {
      const steps = demoSteps(id);
      const funded = steps.findIndex((s) => s.id === "fund");
      assert.ok(funded > 0);
      for (const step of steps.slice(funded, -1)) assert.equal(step.balances.escrow, DEMO_BUDGET);
      for (const step of steps.slice(0, funded)) assert.equal(step.balances.escrow, 0);
      assert.equal(steps.at(-1)?.balances.escrow, 0);
    }
  });

  it("locks three bonds on acceptance and releases them at the end", () => {
    for (const { id } of SCENARIOS) {
      const steps = demoSteps(id);
      const accepted = steps.findIndex((s) => s.id === "accept");
      assert.equal(steps[accepted]?.balances.bonds, 3 * DEMO_BOND);
      assert.equal(steps.at(-1)?.balances.bonds, 0);
    }
  });

  it("links job 1 only where the same step happened there", () => {
    const linked = (id: "honest" | "wrong" | "silent") =>
      demoSteps(id)
        .filter((s) => s.job1 !== undefined)
        .map((s) => s.id);
    assert.deepEqual(linked("honest"), [
      "open",
      "configure",
      "fund",
      "approve",
      "accept",
      "submit",
      "vote",
      "final",
    ]);
    // Job 1 was delivered and approved: a wrong or missing delivery has no transaction there.
    assert.deepEqual(linked("wrong"), ["open", "configure", "fund", "approve", "accept"]);
    assert.deepEqual(linked("silent"), ["open", "configure", "fund", "approve", "accept"]);
    for (const step of demoSteps("honest")) {
      if (step.job1 !== undefined) assert.match(step.job1, /^0x[0-9a-f]{64}$/);
    }
  });

  it("keeps the shown step inside the walkthrough", () => {
    assert.equal(stepAt("honest", -3).id, "start");
    assert.equal(stepAt("silent", 99).id, "final");
    assert.equal(stepAt("wrong", 3.7).id, "fund");
  });
});
