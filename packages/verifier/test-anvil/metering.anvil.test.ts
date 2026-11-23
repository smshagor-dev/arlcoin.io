// Local Anvil acceptance for receipt authentication and composite voting.
// Meter readings here are SYNTHETIC: real CPU/memory accounting is tested separately
// by the gated Docker cgroup v2 integration test. No Solidity changes.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  acceptJob,
  execute,
  executeAndVoteMeteredJob,
  FileMeteringReplayStore,
  readPinnedMeteringArtifact,
  parseSpec,
  produceMeteringReceipt,
  readJob,
  MemberState,
  resolveMeterSigner,
  signMeteringReceipt,
  specHash,
  verifyMeteredEvidence,
  voteMeteredJob,
  type ContainerRunner,
  type Fetcher,
} from "../src/index.ts";

const PORT = 8557;
const RPC = "http://127.0.0.1:" + PORT;
const KEY_DATA: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9c86dae88c7a8412cacc3dc8a9b8a7",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];
const [client, provider, v1, v2] = KEY_DATA.map((key) => privateKeyToAccount(key)) as [
  PrivateKeyAccount,
  PrivateKeyAccount,
  PrivateKeyAccount,
  PrivateKeyAccount,
];
const meterKey = ("0x" + "35".repeat(32)) as Hex;
const meter = privateKeyToAccount(meterKey);
const chain = defineChain({
  id: 31337,
  name: "anvil-metering",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const rpc = createPublicClient({ chain, transport: http(RPC) });
const testClient = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = (account: PrivateKeyAccount) =>
  createWalletClient({ account, chain, transport: http(RPC) });
const registryAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId,string newURI)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
]);
const votedEvent = parseAbiItem(
  "event Voted(uint256 indexed jobId,address indexed validator,bool approve,bytes32 deliverable,bytes32 evidence)",
);
const SPEC = parseSpec({
  version: "arl-reexec/1",
  container_digest: "docker.io/library/busybox@sha256:" + "b".repeat(64),
  inputs: [],
  command: ["sh", "-c", "printf 'passed=3' > /out/result.txt"],
  workdir: ".",
  env: {},
  outputs: ["result.txt"],
  limits: { seconds: 30, memory_mb: 64, cpus: 1 },
  expected_exit_code: 0,
  verifier_digest: "sha256:" + "0".repeat(64),
});
const runner: ContainerRunner = {
  async run(_spec, _work, out) {
    await writeFile(join(out, "result.txt"), "passed=3\n");
    const seconds = Math.floor(Date.now() / 1000);
    return {
      exitCode: 0,
      timedOut: false,
      metering: {
        started_at: seconds,
        finished_at: seconds,
        elapsed_ns: 12_000_000,
        cpu_time_ns: 9_000_000,
        memory_peak_bytes: 12_582_912,
      },
    };
  },
};
const fetcher: Fetcher = {
  file: () => Promise.reject(new Error("unexpected input")),
  git: () => Promise.reject(new Error("unexpected input")),
};
const execOptions = { runner, fetcher };
function artifact(name: string): { abi: Abi; bytecode: { object: Hex } } {
  const path = "../../../contracts/out/" + name + ".sol/" + name + ".json";
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
}
async function deploy(name: string, args: readonly unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet(client).deployContract({ abi, bytecode: bytecode.object, args });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}
async function send(
  account: PrivateKeyAccount,
  address: Address,
  name: string,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const hash = await wallet(account).writeContract({
    address,
    abi: artifact(name).abi,
    functionName,
    args,
  });
  assert.equal((await rpc.waitForTransactionReceipt({ hash })).status, "success");
}

let anvil: ChildProcess;
let token: Address;
let jobs: Address;
let evaluator: Address;
let identity: Address;
let agentId: bigint;

before(async () => {
  const occupied = await rpc.getBlockNumber().then(
    () => true,
    () => false,
  );
  if (occupied) {
    throw new Error("metering Anvil port already serves an RPC; refusing to reuse it");
  }
  anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "31337", "--silent"], {
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try {
      await rpc.getBlockNumber({ cacheTime: 0 });
      break;
    } catch (error) {
      if (i === 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(await rpc.getChainId(), 31337);
  assert.equal(await rpc.getBlockNumber({ cacheTime: 0 }), 0n, "Anvil must be a fresh chain");
  for (const account of [client, provider, v1, v2]) {
    await testClient.setBalance({ address: account.address, value: parseUnits("10", 18) });
  }
  const fixturePath = "../../../apps/dapp/fixtures/erc8004-code.json";
  const fixture = JSON.parse(readFileSync(new URL(fixturePath, import.meta.url), "utf8")) as {
    identityRegistry: { address: Address; code: Hex; storage: Record<string, Hex> };
    identityRegistryImplementation: { address: Address; code: Hex };
  };
  identity = fixture.identityRegistry.address;
  await testClient.setCode({
    address: fixture.identityRegistryImplementation.address,
    bytecode: fixture.identityRegistryImplementation.code,
  });
  await testClient.setCode({ address: identity, bytecode: fixture.identityRegistry.code });
  for (const [index, value] of Object.entries(fixture.identityRegistry.storage)) {
    await testClient.setStorageAt({ address: identity, index: index as Hex, value });
  }
  const regHash = await wallet(provider).writeContract({
    address: identity,
    abi: registryAbi,
    functionName: "register",
    args: ["data:application/json;base64,e30="],
  });
  const regReceipt = await rpc.waitForTransactionReceipt({ hash: regHash });
  assert.equal(regReceipt.status, "success");
  const events = parseEventLogs({
    abi: registryAbi,
    logs: regReceipt.logs,
    eventName: "Registered",
  });
  assert.equal(events.length, 1);
  assert.ok(events[0]);
  agentId = events[0].args.agentId;

  const holder = client.address;
  token = await deploy("ARLToken", [{
    publicLaunch: holder,
    communityStaking: holder,
    ecosystemGrowth: holder,
    strategicPartnerships: holder,
    liquidity: holder,
    founder: holder,
    investors: holder,
    treasury: holder,
    team: holder,
    earlyUsers: holder,
    grantsBugBounty: holder,
  }]);
  jobs = await deploy("ARLJobs", [token]);
  evaluator = await deploy("ARLVerifiedEvaluator", [
    jobs,
    "0x000000000000000000000000000000000000A4b1",
    3600n,
    parseUnits("1", 18),
    identity,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
  ]);
  for (const validator of [v1, v2]) {
    await send(client, token, "ARLToken", "transfer", [validator.address, parseUnits("100", 18)]);
    await send(validator, token, "ARLToken", "approve", [evaluator, parseUnits("100", 18)]);
    await send(validator, evaluator, "ARLVerifiedEvaluator", "stake", [parseUnits("100", 18)]);
  }
  await send(client, token, "ARLToken", "approve", [jobs, parseUnits("50", 18)]);
});
after(() => { anvil?.kill(); });

describe("metered votes against the real local evaluator", () => {
  it("rejects tampering, records two composite votes and settles a verified job", async () => {
    const { timestamp } = await rpc.getBlock();
    await send(client, jobs, "ARLJobs", "createJob", [
      provider.address,
      evaluator,
      timestamp + 86_400n,
      "https://example.org/metered-job.json",
      "0x0000000000000000000000000000000000000000",
    ]);
    const jobId = 1n;
    await send(client, evaluator, "ARLVerifiedEvaluator", "configure", [
      jobId,
      {
        tier: 1,
        threshold: 2,
        voteWindow: 3600n,
        challengeWindow: 3600n,
        bond: parseUnits("1", 18),
        providerAgentId: agentId,
        specHash: specHash(SPEC),
        committee: [v1.address, v2.address],
      },
    ]);
    await send(provider, evaluator, "ARLVerifiedEvaluator", "approveCommittee", [jobId]);
    await send(provider, jobs, "ARLJobs", "setBudget", [jobId, parseUnits("20", 18), "0x"]);
    await send(client, jobs, "ARLJobs", "fund", [jobId, parseUnits("20", 18), "0x"]);
    for (const validator of [v1, v2]) {
      await acceptJob(wallet(validator), rpc, evaluator, jobId);
    }

    // Publish and pin the meter signer BEFORE the provider executes or signs usage.
    // The validator resolves this historical snapshot, not a later mutable URI.
    const registrationDocument = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      registrations: [
        { agentRegistry: "eip155:31337:" + identity.toLowerCase(), agentId: agentId.toString() },
      ],
      extensions: { "arl-metering-receipt/1": { signer: meter.address } },
    };
    const registrationBytes = Buffer.from(JSON.stringify(registrationDocument));
    const uri = "data:application/json;base64," + registrationBytes.toString("base64");
    const uriTx = await wallet(provider).writeContract({
      address: identity,
      abi: registryAbi,
      functionName: "setAgentURI",
      args: [agentId, uri],
    });
    assert.equal((await rpc.waitForTransactionReceipt({ hash: uriTx })).status, "success");
    const registration = {
      chainId: 31337,
      evaluatorAddress: evaluator,
      jobId,
      registrationBlock: await rpc.getBlockNumber({ cacheTime: 0 }),
      pinnedRegistrationSha256: (
        "0x" + createHash("sha256").update(registrationBytes).digest("hex")
      ) as Hex,
      registrationBytes,
    };
    assert.equal(
      await rpc.readContract({ address: identity, abi: registryAbi, functionName: "tokenURI",
        args: [agentId] }),
      uri,
    );

    const providerRun = await execute(SPEC, execOptions);
    const signed = await produceMeteringReceipt(SPEC, providerRun, {
      chainId: 31337,
      evaluatorAddress: evaluator,
      jobId: jobId.toString(),
      meterPrivateKey: meterKey,
    });
    await send(provider, jobs, "ARLJobs", "submit", [jobId, providerRun.hash, "0x"]);

    const independent = await execute(SPEC, execOptions);
    assert.equal(independent.hash, providerRun.hash);
    const directory = await mkdtemp(join(tmpdir(), "arl-metered-anvil-"));
    try {
      // Standalone local receipt handoff: no unapproved network transport and no
      // validator access to the provider private key.
      const artifactPath = join(directory, "provider-receipt.json");
      const artifactBytes = Buffer.from(JSON.stringify(signed) + "\n");
      await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
      const artifactSha256 = (
        "0x" + createHash("sha256").update(artifactBytes).digest("hex")
      ) as Hex;
      const { signed: delivered } = await readPinnedMeteringArtifact(
        artifactPath,
        artifactSha256,
      );
      assert.equal(delivered.signature, signed.signature);
      const common = {
        client: rpc,
        evaluator,
        jobId,
        spec: SPEC,
        result: independent.result,
        registration,
        maxReceiptAgeSeconds: 300,
      };
      const firstStore = new FileMeteringReplayStore(directory, v1.address);
      const changed = {
        ...signed,
        receipt: { ...signed.receipt, cpu_time_ns: signed.receipt.cpu_time_ns + 1 },
      };
      await assert.rejects(
        () => voteMeteredJob({
          ...common, wallet: wallet(v1), receipt: changed, replay: firstStore,
        }),
        { code: "SIGNER_MISMATCH" },
      );
      const impossibleMemory = {
        ...signed,
        receipt: { ...signed.receipt, memory_peak_bytes: 200 * 1024 * 1024 },
      };
      await assert.rejects(
        () => voteMeteredJob({
          ...common, wallet: wallet(v1), receipt: impossibleMemory, replay: firstStore,
        }),
        { code: "INVALID_MEASUREMENT" },
      );
      const unauthorized = await signMeteringReceipt(
        signed.receipt,
        ("0x" + "36".repeat(32)) as Hex,
      );
      await assert.rejects(
        () =>
          voteMeteredJob({
            ...common,
            wallet: wallet(v1),
            receipt: unauthorized,
            replay: firstStore,
          }),
        { code: "SIGNER_MISMATCH" },
      );
      let invalidReceiptExecutions = 0;
      const forbiddenRunner: ContainerRunner = {
        async run() {
          invalidReceiptExecutions++;
          throw new Error("untrusted receipt should never start a container");
        },
      };
      await assert.rejects(
        () =>
          executeAndVoteMeteredJob({
            ...common,
            wallet: wallet(v1),
            receipt: unauthorized,
            replay: firstStore,
            execution: { ...execOptions, runner: forbiddenRunner },
          }),
        { code: "SIGNER_MISMATCH" },
      );
      assert.equal(invalidReceiptExecutions, 0, "preflight must precede re-execution");
      const historicalTime = Math.floor(Date.now() / 1000) - 3_600;
      const expired = await signMeteringReceipt(
        {
          ...signed.receipt,
          started_at: historicalTime,
          finished_at: historicalTime,
        },
        meterKey,
      );
      await assert.rejects(
        () =>
          voteMeteredJob({
            ...common,
            wallet: wallet(v1),
            receipt: expired,
            replay: firstStore,
          }),
        { code: "RECEIPT_EXPIRED" },
      );
      assert.equal((await readJob(rpc, evaluator, jobId, v1.address)).memberState, MemberState.Accepted);
      await assert.rejects(
        () => voteMeteredJob({
          ...common, wallet: wallet(v1), receipt: delivered, replay: firstStore,
          registration: {
            ...registration,
            pinnedRegistrationSha256: ("0x" + "0".repeat(64)) as Hex,
          },
        }),
        { code: "REGISTRATION_UNAVAILABLE" },
      );
      const first = await executeAndVoteMeteredJob({
        ...common,
        wallet: wallet(v1),
        receipt: delivered,
        replay: firstStore,
        execution: execOptions,
      });
      const second = await executeAndVoteMeteredJob({
        ...common,
        wallet: wallet(v2),
        receipt: delivered,
        replay: new FileMeteringReplayStore(directory, v2.address),
        execution: execOptions,
      });
      assert.equal(first.execution.hash, providerRun.hash);
      assert.equal(second.execution.hash, providerRun.hash);
      assert.equal(first.evidenceHash, second.evidenceHash);
      const { expectedSigner } = await resolveMeterSigner(rpc, registration);
      const audited = await verifyMeteredEvidence({
        spec: SPEC,
        result: first.execution.result,
        receipt: delivered,
        context: {
          chainId: 31337,
          evaluatorAddress: evaluator,
          jobId: jobId.toString(),
          specHash: specHash(SPEC),
          deliverableHash: providerRun.hash,
          containerDigest: SPEC.container_digest,
          expectedSigner,
        },
        expectedEvidenceHash: first.evidenceHash,
      });
      assert.equal(audited.evidenceHash, first.evidenceHash);
      const logs = await rpc.getLogs({
        address: evaluator, event: votedEvent, args: { jobId }, fromBlock: 0n,
      });
      assert.equal(logs.length, 2);
      for (const entry of logs) {
        assert.equal(entry.args.approve, true);
        assert.equal(entry.args.evidence, first.evidenceHash);
        assert.equal(entry.args.deliverable, providerRun.hash);
      }
      assert.equal((await readJob(rpc, evaluator, jobId, v1.address)).phase, 2);
      await testClient.increaseTime({ seconds: 3601 });
      await testClient.mine({ blocks: 1 });
      await send(client, evaluator, "ARLVerifiedEvaluator", "finalize", [jobId]);
      const paid = await rpc.readContract({
        address: token, abi: erc20Abi, functionName: "balanceOf", args: [provider.address],
      });
      assert.equal(paid, parseUnits("20", 18));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
