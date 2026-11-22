import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CAPS, planHires, type Listing, type State } from "../src/policy.ts";

const ARL = 10n ** 18n;
const addr = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const listing = (id: number, price = 50n, extra: Partial<Listing> = {}): Listing => ({
  agentId: BigInt(id),
  owner: addr(1000 + id),
  payTo: addr(1000 + id),
  unitPrice: price * ARL,
  active: true,
  ...extra,
});
const NOW = 1_800_000_000n;
const base: State = {
  self: addr(1),
  excluded: [addr(2)],
  opened: [],
  spendable: 5_000n * ARL,
  now: NOW,
};

describe("planHires", () => {
  it("hires active listings in agent order at their price", () => {
    const hires = planHires([listing(3), listing(2, 20n)], base);
    assert.deepEqual(
      hires.map((h) => [h.listing.agentId, h.budget]),
      [
        [2n, 20n * ARL],
        [3n, 50n * ARL],
      ],
    );
  });

  it("caps the budget per job and skips listings below the minimum", () => {
    const hires = planHires([listing(1, 1_000n), listing(2, 1n)], base);
    assert.deepEqual(
      hires.map((h) => [h.listing.agentId, h.budget]),
      [[1n, DEFAULT_CAPS.maxBudget]],
    );
  });

  it("never pays itself, an excluded wallet or an inactive listing", () => {
    const hires = planHires(
      [
        listing(1, 50n, { owner: addr(1) }),
        listing(2, 50n, { payTo: addr(2) }),
        listing(3, 50n, { active: false }),
        listing(4),
      ],
      base,
    );
    assert.deepEqual(
      hires.map((h) => h.listing.agentId),
      [4n],
    );
  });

  it("hires each owner once, even across several listings and runs", () => {
    const twin = listing(6, 50n, { owner: addr(1005), payTo: addr(1005) });
    assert.equal(planHires([listing(5), twin], base).length, 1);
    const later = { ...base, opened: [{ provider: addr(1005), openedAt: NOW - 10n * 86_400n }] };
    assert.equal(planHires([listing(5), twin], later).length, 0);
  });

  it("stops at the daily cap, counting jobs already opened today", () => {
    const many = Array.from({ length: 30 }, (_, i) => listing(100 + i, 10n));
    assert.equal(planHires(many, base).length, DEFAULT_CAPS.maxJobsPerDay);
    const today = { ...base, opened: [{ provider: addr(9), openedAt: NOW - 60n }] };
    assert.equal(planHires(many, today).length, DEFAULT_CAPS.maxJobsPerDay - 1);
  });

  it("never plans more than it can spend", () => {
    const hires = planHires([listing(1), listing(2), listing(3)], {
      ...base,
      spendable: 120n * ARL,
    });
    assert.equal(hires.length, 2);
    assert.ok(hires.reduce((s, h) => s + h.budget, 0n) <= 120n * ARL);
  });
});
