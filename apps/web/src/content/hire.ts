// The ARL agent's service and the spec a client opens a job with. The spec is the one
// packages/verifier builds with `nodeTestSpec` (src/make.ts): the same fields and values, so its
// hash is the hash the validators compute. test/unit/hire.test.ts pins that against the hash of
// the spec that was run in Docker (docs/run-a-provider.md).
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** ARL AIBORG: the provider agent, as registered in the ERC-8004 identity registry on Base. */
export const ARL_AGENT = {
  name: "ARL AIBORG",
  id: "1221687",
  address: "0x69CF9b31076E6d4F581A79045eBAbc624E3cd4bf",
  /** Smallest budget the agent takes a job for, in ARL. */
  minBudget: 100,
  /** Longest run and most memory the agent gives one job. */
  maxSeconds: 300,
  maxMemoryMb: 512,
} as const;

const NODE_IMAGE =
  "docker.io/library/node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a";
const VERIFIER_DIGEST = "sha256:02119efebb69c51cd27855462ab8618d4d6f8cc0ebbc2e6943b41f9ca99efc02";
const NODE_TEST_COMMAND = [
  "sh",
  "-c",
  "node --test --test-reporter=tap > /tmp/tap.txt 2>&1; code=$?; " +
    "grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo) ' /tmp/tap.txt > /out/summary.txt; " +
    "exit $code",
];

const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface HireInput {
  repository: string;
  commit: string;
  directory: string;
}

export type HireSpec = { ok: true; json: string; hash: string } | { ok: false; error: string };

type Json = string | number | Json[] | { [key: string]: Json };

/** Canonical JSON as the verifier hashes it: keys sorted, no whitespace, integers only. */
function canonical(value: Json): string {
  if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k] as Json)}`).join(",")}}`;
}

/** The spec of a verified test run of `repository` at `commit`, as a file and its hash. */
export function hireSpec(input: HireInput): HireSpec {
  const repository = input.repository.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(repository);
  } catch {
    parsed = null;
  }
  if (parsed?.protocol !== "https:") {
    return { ok: false, error: "The repository is an https:// link, the one you clone it from." };
  }
  const commit = input.commit.trim();
  if (!COMMIT.test(commit)) {
    return {
      ok: false,
      error: "The commit is the full id (40 characters, lowercase), not a branch or a short id.",
    };
  }
  const parts = input.directory
    .trim()
    .split("/")
    .filter((part) => part !== "");
  if (parts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) {
    return {
      ok: false,
      error: "The directory is a path inside the repository, such as packages/api.",
    };
  }
  const spec: Json = {
    version: "arl-reexec/1",
    container_digest: NODE_IMAGE,
    inputs: [{ kind: "git", path: "repo", url: repository, commit }],
    command: NODE_TEST_COMMAND,
    workdir: parts.length === 0 ? "repo" : `repo/${parts.join("/")}`,
    env: { TZ: "UTC" },
    outputs: ["summary.txt"],
    limits: { seconds: ARL_AGENT.maxSeconds, memory_mb: ARL_AGENT.maxMemoryMb, cpus: 1 },
    expected_exit_code: 0,
    verifier_digest: VERIFIER_DIGEST,
  };
  return {
    ok: true,
    json: `${JSON.stringify(spec, null, 2)}\n`,
    hash: `0x${bytesToHex(keccak_256(utf8ToBytes(canonical(spec))))}`,
  };
}

/** The app's job form, filled for the agent: the client only confirms in the wallet. */
export function hireLink(specUrl: string): string | null {
  const url = specUrl.trim();
  if (!/^https:\/\/\S+$/.test(url) && !/^ipfs:\/\/\S+$/.test(url)) return null;
  const query = new URLSearchParams({
    spec: url,
    provider: ARL_AGENT.address,
    agent: ARL_AGENT.id,
    budget: String(ARL_AGENT.minBudget),
  });
  return `/app/verified/?${query.toString()}`;
}
