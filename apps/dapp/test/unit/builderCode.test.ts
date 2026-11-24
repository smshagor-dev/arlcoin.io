import assert from "node:assert/strict";
import { test } from "node:test";
import { Attribution } from "ox/erc8021";
import { BUILDER_CODE, BUILDER_SUFFIX, builderSuffix } from "../../lib/builderCode.ts";

test("the suffix is the ERC-8021 encoding of the Builder Code", () => {
  assert.equal(BUILDER_SUFFIX, Attribution.toDataSuffix({ codes: [BUILDER_CODE] }));
});

test("the suffix is added on Base Mainnet only", () => {
  assert.equal(builderSuffix(8453), BUILDER_SUFFIX);
  for (const id of [84532, 31337, 1, undefined]) assert.equal(builderSuffix(id), undefined);
});
