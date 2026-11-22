// Usage:
//   node packages/deploy/src/signal-record-cli.ts <run.json> <rpc-url> <record.json>
//
// Writes the record of the anonymous signals contracts on Base Mainnet from the run file of
// `DeployMainnetSignal` (the dry-run file the Deploy screen signed). Every check runs on chain
// first and nothing is written unless all pass:
// - the run creates the verifier and ARLAnonymousSignal, and no other contract than the
//   verifier's two libraries;
// - both libraries named by the run have code, and so do the verifier and the contract;
// - the contract points at that verifier;
// - the verifier accepts a real proof (the committed fixture, contracts/test/fixtures/zk) and
//   refuses the same proof with a changed message.
// Base Mainnet (8453) only. Exit codes: 0 written, 3 a check failed, 1 could not run, 2 usage.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  encodePacked,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";

const LIBRARIES = ["RelationsLib", "ZKTranscriptLib"] as const;

const [runPath, rpc, outPath] = process.argv.slice(2);
if (!runPath || !rpc || !outPath) {
  process.stderr.write("usage: signal-record-cli.ts <run.json> <rpc-url> <record.json>\n");
  process.exit(2);
}

const abi = parseAbi([
  "function verifier() view returns (address)",
  "function groupCount() view returns (uint256)",
  "function verify(bytes proof, bytes32[] publicInputs) view returns (bool)",
]);

interface RunTx {
  transactionType?: string;
  contractName?: string;
  contractAddress?: string;
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${what}\n`);
  if (!ok) failures.push(what);
};

const run = JSON.parse(readFileSync(runPath, "utf8")) as {
  transactions?: RunTx[];
  libraries?: string[];
};
const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
if (chainId !== 8453) {
  process.stderr.write(`signal record rejected: chain ${String(chainId)} is not Base Mainnet\n`);
  process.exit(3);
}

const txs = run.transactions ?? [];
const created = (name: string) => {
  const t = txs.find((x) => x.transactionType === "CREATE" && x.contractName === name);
  return t?.contractAddress ? getAddress(t.contractAddress) : undefined;
};
const verifier = created("HonkVerifier");
const signal = created("ARLAnonymousSignal");
const others = txs.filter(
  (t) =>
    !(
      t.transactionType === "CREATE" &&
      (t.contractName === "HonkVerifier" || t.contractName === "ARLAnonymousSignal")
    ) &&
    !(
      t.transactionType === "CREATE2" &&
      LIBRARIES.includes(t.contractName as (typeof LIBRARIES)[number])
    ),
);
check(
  verifier !== undefined && signal !== undefined && others.length === 0,
  "run creates the verifier, ARLAnonymousSignal and at most the two verifier libraries",
);
if (!verifier || !signal) process.exit(3);

// forge names the libraries the verifier was linked to as `<source>:<name>:<address>`.
const libraries: Record<string, Address> = {};
for (const entry of run.libraries ?? []) {
  const [, name, address] = entry.split(":");
  if (name && address) libraries[name] = getAddress(address);
}
check(
  LIBRARIES.every((l) => libraries[l] !== undefined) && Object.keys(libraries).length === 2,
  "run names the two verifier libraries",
);

const hasCode = async (address: Address) => {
  const code = await client.getCode({ address });
  return code !== undefined && code.length > 2;
};
for (const name of LIBRARIES) {
  const address = libraries[name];
  if (address) check(await hasCode(address), `${name} has code at ${address}`);
}
check(await hasCode(verifier), `HonkVerifier has code at ${verifier}`);
check(await hasCode(signal), `ARLAnonymousSignal has code at ${signal}`);

const pointsAt = getAddress(
  await client.readContract({ address: signal, abi, functionName: "verifier" }),
);
check(pointsAt === verifier, `the contract uses that verifier (${pointsAt})`);

// A real proof from the committed fixture, checked by the deployed verifier itself.
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "contracts",
  "test",
  "fixtures",
  "zk",
  "signals.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  signals: { scope: string; message: string; root: string; nullifier: string; proof: Hex }[];
};
const first = fixture.signals[0];
if (!first) {
  process.stderr.write("signal record not written: the proof fixture is empty\n");
  process.exit(1);
}
// As ARLAnonymousSignal.hashToField: keccak256 of the 32-byte value, shifted into the field.
const toField = (value: bigint) => BigInt(keccak256(encodePacked(["uint256"], [value]))) >> 8n;
const word = (value: bigint) => pad(toHex(value), { size: 32 });
const inputs = (message: bigint) => [
  word(toField(BigInt(first.scope))),
  word(toField(message)),
  word(BigInt(first.root)),
  word(BigInt(first.nullifier)),
];
const verify = (message: bigint) =>
  client
    .readContract({
      address: verifier,
      abi,
      functionName: "verify",
      args: [first.proof, inputs(message)],
    })
    .catch(() => false);
check(await verify(BigInt(first.message)), "the verifier accepts a real proof");
check(
  !(await verify(BigInt(first.message) + 1n)),
  "the verifier refuses that proof with another message",
);

if (failures.length > 0) {
  process.stderr.write(`signal record not written: ${String(failures.length)} check(s) failed\n`);
  process.exit(3);
}
const groupCount = await client.readContract({ address: signal, abi, functionName: "groupCount" });
const clientVersion: string = await client
  .request({ method: "web3_clientVersion" } as never)
  .then((v) => String(v))
  .catch(() => "");
const record = {
  // A local Anvil fork answers chain 8453 too; its record is a rehearsal, not evidence.
  network: clientVersion.toLowerCase().includes("anvil")
    ? "base-mainnet-fork-rehearsal"
    : "base-mainnet",
  chainId,
  signal,
  verifier,
  libraries,
  groupCount: Number(groupCount),
  block: String(await client.getBlockNumber()),
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`signal record written: ${outPath}\n`);
