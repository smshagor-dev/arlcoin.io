import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_BATCH,
  PollError,
  SNARK_FIELD,
  checkPoll,
  optionMessage,
  parseCommitments,
  parsePollQuery,
  pollQuery,
  pollScope,
  tallyPoll,
} from "../../lib/privatePoll.ts";

const poll = {
  group: 3n,
  poll: 7n,
  question: "Which check should the validators run next?",
  options: ["GPU inference", "Research", "Something else"],
};

const refused = (f: () => unknown, pattern: RegExp) =>
  assert.throws(f, (e: unknown) => e instanceof PollError && pattern.test(e.message));

describe("private poll links", () => {
  it("carries a poll through a link and back", () => {
    const query = pollQuery(poll);
    assert.deepEqual(parsePollQuery(`?${query}`), poll);
    assert.deepEqual(parsePollQuery(query), poll);
    // Text with characters that need escaping survives too.
    const odd = { ...poll, question: "A & B = C? 100% #1", options: ["yes, please", "no/never"] };
    assert.deepEqual(parsePollQuery(pollQuery(odd)), odd);
  });

  it("tidies whitespace and keeps the options in order", () => {
    const tidy = checkPoll({ ...poll, question: "  Which   one? ", options: [" b ", "a"] });
    assert.equal(tidy.question, "Which one?");
    assert.deepEqual(tidy.options, ["b", "a"]);
  });

  it("names no poll when the link has none, and refuses a broken one", () => {
    assert.equal(parsePollQuery(""), undefined);
    assert.equal(parsePollQuery("?plan=x"), undefined);
    refused(() => parsePollQuery("?group=1"), /no valid poll number/);
    refused(() => parsePollQuery("?group=abc&poll=1&q=x&o=a&o=b"), /no valid group number/);
    refused(() => parsePollQuery("?group=-1&poll=1&q=x&o=a&o=b"), /no valid group number/);
    refused(() => parsePollQuery("?group=1&poll=1&o=a&o=b"), /no question/);
    refused(() => parsePollQuery("?group=1&poll=1&q=x&o=a"), /at least two options/);
    refused(() => parsePollQuery("?group=1&poll=1&q=x&o=a&o=a"), /two options are the same/);
    refused(() => parsePollQuery("?group=1&poll=1&q=x&o=a&o="), /an option is empty/);
    refused(
      () => checkPoll({ ...poll, options: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }),
      /at most 8 options/,
    );
    refused(() => checkPoll({ ...poll, question: "x".repeat(201) }), /question is too long/);
    refused(() => checkPoll({ ...poll, options: ["a", "x".repeat(81)] }), /option is too long/);
    refused(() => checkPoll({ ...poll, poll: 1n << 128n }), /poll number is out of range/);
  });

  it("builds the scope the contract accepts for the group", () => {
    assert.equal(pollScope(0n, 1n), 1n);
    assert.equal(pollScope(3n, 7n), (3n << 128n) | 7n);
    // ARLAnonymousSignal: `scope >> SCOPE_GROUP_SHIFT` must equal the group id.
    assert.equal(pollScope(3n, 7n) >> 128n, 3n);
    assert.equal(pollScope(5n, (1n << 128n) - 1n) >> 128n, 5n);
    refused(() => pollScope(1n, 1n << 128n), /poll number is out of range/);
    refused(() => pollScope(-1n, 1n), /group number is out of range/);
  });

  it("counts only the signals of the poll that name one of its options", () => {
    const scope = pollScope(3n, 7n);
    const other = pollScope(3n, 8n);
    assert.deepEqual(
      tallyPoll(
        [
          { scope, message: 1n },
          { scope, message: 3n },
          { scope, message: 1n },
          { scope: other, message: 1n },
          { scope, message: 0n },
          { scope, message: 4n },
        ],
        scope,
        3,
      ),
      [2, 0, 1],
    );
    assert.equal(optionMessage(0), 1n);
  });
});

describe("member commitments", () => {
  it("uses the field of the contract", () => {
    const source = readFileSync(
      new URL("../../../../contracts/src/ARLAnonymousSignal.sol", import.meta.url),
      "utf8",
    );
    const literal = /SNARK_FIELD =\s*([\d_]+);/.exec(source)?.[1]?.replace(/_/g, "");
    assert.equal(literal, SNARK_FIELD.toString());
  });

  it("reads decimal and hex commitments in any common layout", () => {
    assert.deepEqual(parseCommitments("11\n22\n33"), [11n, 22n, 33n]);
    assert.deepEqual(parseCommitments(" 11, 0x16 ;33 \n"), [11n, 22n, 33n]);
    assert.deepEqual(parseCommitments((SNARK_FIELD - 1n).toString()), [SNARK_FIELD - 1n]);
  });

  it("refuses what the contract would refuse, before anything is signed", () => {
    refused(() => parseCommitments("  "), /at least one commitment/);
    refused(() => parseCommitments("0"), /line 1 is not a commitment/);
    refused(() => parseCommitments(`5\n${SNARK_FIELD.toString()}`), /line 2 is not a commitment/);
    refused(() => parseCommitments("5\nhello"), /line 2 is not a commitment/);
    refused(() => parseCommitments("5\n-3"), /line 2 is not a commitment/);
    refused(() => parseCommitments("5\n0x5"), /line 2 is already a member/);
    refused(() => parseCommitments("7", [7n]), /line 1 is already a member/);
    refused(
      () => parseCommitments(Array.from({ length: MAX_BATCH + 1 }, (_, i) => i + 1).join("\n")),
      /at most 200 members/,
    );
  });
});
