// Private polls on ARLAnonymousSignal, for any group: what a poll link carries, the scope it
// votes in, how votes are counted and how a pasted list of member commitments is read.
//
// On chain a poll is only a scope and numbered messages: the contract does not know the question
// or the options. They travel in the link the group's admin shares, so the page always says that
// the wording comes from the link. A link cannot move a vote: the scope is fixed by the group and
// the poll number, and the contract accepts one signal per member in it.

/** BN254 scalar field order, as `ARLAnonymousSignal.SNARK_FIELD` and `@arl/zk`. */
export const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** A scope carries its group id above this bit (`ARLAnonymousSignal.scopeFor`). */
const SCOPE_GROUP_SHIFT = 128n;
const MAX_POLL_ID = (1n << SCOPE_GROUP_SHIFT) - 1n;
const MAX_GROUP_ID = (1n << 128n) - 1n;

export const MAX_OPTIONS = 8;
export const MAX_QUESTION = 200;
export const MAX_OPTION = 80;
/** Most commitments one transaction publishes from the page; larger groups are added in parts. */
export const MAX_BATCH = 200;

export interface PrivatePoll {
  group: bigint;
  poll: bigint;
  question: string;
  options: string[];
}

export class PollError extends Error {
  override name = "PollError";
}

const fail = (message: string): never => {
  throw new PollError(message);
};

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** Checks a poll and returns it with its text tidied. */
export function checkPoll(p: PrivatePoll): PrivatePoll {
  if (p.group < 0n || p.group > MAX_GROUP_ID) fail("the group number is out of range");
  if (p.poll < 0n || p.poll > MAX_POLL_ID) fail("the poll number is out of range");
  const question = clean(p.question);
  if (question === "") fail("the poll has no question");
  if (question.length > MAX_QUESTION) fail("the question is too long");
  const options = p.options.map(clean);
  if (options.length < 2) fail("a poll needs at least two options");
  if (options.length > MAX_OPTIONS) fail(`a poll has at most ${String(MAX_OPTIONS)} options`);
  if (options.some((o) => o === "")) fail("an option is empty");
  if (options.some((o) => o.length > MAX_OPTION)) fail("an option is too long");
  if (new Set(options).size !== options.length) fail("two options are the same");
  return { group: p.group, poll: p.poll, question, options };
}

/** The query string of a poll link: `group`, `poll`, `q` and one `o` per option, in order. */
export function pollQuery(p: PrivatePoll): string {
  const poll = checkPoll(p);
  const q = new URLSearchParams();
  q.set("group", poll.group.toString());
  q.set("poll", poll.poll.toString());
  q.set("q", poll.question);
  for (const o of poll.options) q.append("o", o);
  return q.toString();
}

const number = (value: string | null, what: string): bigint => {
  if (value === null || !/^\d{1,39}$/.test(value)) fail(`the link has no valid ${what} number`);
  return BigInt(value as string);
};

/** Reads a poll link. `undefined` when the query names no poll at all; throws when it names one
 * badly, so a broken link is never shown as another poll. */
export function parsePollQuery(search: string): PrivatePoll | undefined {
  const q = new URLSearchParams(search);
  if (!q.has("group") && !q.has("poll") && !q.has("q") && !q.has("o")) return undefined;
  return checkPoll({
    group: number(q.get("group"), "group"),
    poll: number(q.get("poll"), "poll"),
    question: q.get("q") ?? "",
    options: q.getAll("o"),
  });
}

/** The scope of a poll: the group id in the upper 128 bits, as the contract requires. */
export function pollScope(group: bigint, poll: bigint): bigint {
  if (group < 0n || group > MAX_GROUP_ID) fail("the group number is out of range");
  if (poll < 0n || poll > MAX_POLL_ID) fail("the poll number is out of range");
  return (group << SCOPE_GROUP_SHIFT) | poll;
}

/** Option index (0-based) to the signalled message (1-based). */
export const optionMessage = (index: number): bigint => BigInt(index + 1);

/** Counts the signals of `scope` per option; a message that names no option is not counted. */
export function tallyPoll(
  signals: readonly { scope: bigint; message: bigint }[],
  scope: bigint,
  optionCount: number,
): number[] {
  const counts = Array.from({ length: optionCount }, () => 0);
  for (const s of signals) {
    if (s.scope !== scope) continue;
    if (s.message < 1n || s.message > BigInt(optionCount)) continue;
    const i = Number(s.message) - 1;
    counts[i] = (counts[i] ?? 0) + 1;
  }
  return counts;
}

/**
 * Reads member commitments pasted one per line (or separated by commas or spaces), decimal or
 * 0x hex. Every one must be a non-zero field element, and none may repeat here or in `existing`.
 */
export function parseCommitments(text: string, existing: readonly bigint[] = []): bigint[] {
  const parts = text.split(/[\s,;]+/).filter((p) => p !== "");
  if (parts.length === 0) fail("paste at least one commitment");
  if (parts.length > MAX_BATCH) fail(`add at most ${String(MAX_BATCH)} members at a time`);
  const seen = new Set(existing);
  return parts.map((part, i) => {
    if (!/^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(part)) {
      fail(`line ${String(i + 1)} is not a commitment`);
    }
    const value = BigInt(part);
    if (value === 0n || value >= SNARK_FIELD) fail(`line ${String(i + 1)} is not a commitment`);
    if (seen.has(value)) fail(`line ${String(i + 1)} is already a member`);
    seen.add(value);
    return value;
  });
}
