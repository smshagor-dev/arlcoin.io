// Deploy screen: signs a prepared ARL deployment from a phone wallet, one transaction at a time.
//
// The transactions come from a Foundry dry run (`forge script … --sender <your address>` without
// `--broadcast`), which writes `broadcast/<Script>/<chain>/dry-run/run-latest.json`. Nothing here
// creates, stores or asks for a key: the wallet signs each transaction itself.
//
// A run file is untrusted input. Before a transaction is offered for signing it must be one of:
// - a contract creation whose code is exactly the ARL build (`DEPLOY_ARTIFACTS`), with its
//   constructor arguments decoded for display;
// - a Safe creation through the canonical Safe v1.5.0 SafeProxyFactory with a canonical
//   singleton, with its owners and threshold decoded for display;
// - for the zero-knowledge verifier (`ZK_DEPLOY_ARTIFACTS`): one of its two libraries created
//   through the canonical CREATE2 deployer with the zero salt, so that its address follows from
//   its code alone, or the verifier itself, whose code must be the ARL build linked to exactly
//   those two addresses.
// Anything else is refused. The chain must be Base Mainnet (from the TGE) or the local Anvil chain
// (`assertAllowedChain`).

import {
  decodeAbiParameters,
  decodeFunctionData,
  formatUnits,
  getAddress,
  getContractAddress,
  isAddress,
  keccak256,
  parseAbi,
  slice,
  type Address,
  type Hex,
} from "viem";

import { DEPLOY_ARTIFACTS, ZK_DEPLOY_ARTIFACTS } from "./deployArtifacts.ts";
import { LOCAL_CHAIN_ID, assertAllowedChain } from "./network.ts";

/** The creation code a run may contain, per contract. */
export type DeployArtifacts = {
  readonly [K in keyof typeof DEPLOY_ARTIFACTS]?: {
    readonly creationHash: string;
    readonly creationSize: number;
    readonly constructorInputs: readonly unknown[];
  };
};

/** Canonical Safe v1.5.0 contracts (safe-global/safe-deployments), as pinned in CreateSafes. */
export const SAFE_FACTORY_V150: Address = "0x14F2982D601c9458F93bd70B218933A6f8165e7b";
export const SAFE_SINGLETONS_V150: readonly Address[] = [
  "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
  "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e",
];

/** The canonical CREATE2 deployer (Arachnid's deterministic deployment proxy), used by forge
 * for libraries: `to` it, the data is a 32-byte salt followed by the creation code. */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const ZERO_SALT = `0x${"00".repeat(32)}` as const;

export type ZkLibrary = keyof typeof ZK_DEPLOY_ARTIFACTS.libraries;

/** The verifier build a run may contain: the current one, except in tests of earlier runs. */
export interface ZkArtifacts {
  readonly libraries: {
    readonly [L in ZkLibrary]: { readonly creationHash: string; readonly creationSize: number };
  };
  readonly HonkVerifier: {
    readonly blankedCreationHash: string;
    readonly creationSize: number;
    readonly links: readonly { readonly library: ZkLibrary; readonly start: number }[];
  };
}

/** Where a verifier library lives: fixed by its creation code, on every chain. */
export function zkLibraryAddress(
  library: ZkLibrary,
  zk: ZkArtifacts = ZK_DEPLOY_ARTIFACTS,
): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: CREATE2_DEPLOYER,
    salt: ZERO_SALT,
    bytecodeHash: zk.libraries[library].creationHash as Hex,
  });
}

const factoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
]);
const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
]);

export type DeployStep =
  | {
      kind: "create";
      index: number;
      contract: keyof typeof DEPLOY_ARTIFACTS;
      /** Where the contract will be created (from the sender and nonce). */
      address: Address;
      from: Address;
      nonce: number;
      data: Hex;
      gas?: bigint;
      args: readonly unknown[];
    }
  | {
      /** A library of the zero-knowledge verifier, created through the CREATE2 deployer. */
      kind: "library";
      index: number;
      library: ZkLibrary;
      address: Address;
      from: Address;
      nonce: number;
      data: Hex;
      gas?: bigint;
    }
  | {
      /** The zero-knowledge verifier, linked to its two libraries. */
      kind: "verifier";
      index: number;
      address: Address;
      libraries: Record<ZkLibrary, Address>;
      from: Address;
      nonce: number;
      data: Hex;
      gas?: bigint;
    }
  | {
      kind: "safe";
      index: number;
      factory: Address;
      singleton: Address;
      owners: Address[];
      threshold: bigint;
      /** The Safe proxy the dry run created. */
      safe?: Address;
      from: Address;
      nonce: number;
      data: Hex;
      gas?: bigint;
    };

export interface DeployRun {
  chainId: number;
  from: Address;
  steps: DeployStep[];
}

export class DeployRunError extends Error {
  override name = "DeployRunError";
}

function fail(message: string): never {
  throw new DeployRunError(message);
}

const hexNumber = (v: unknown, field: string): number => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) fail(`${field} is not a hex number`);
  return Number(BigInt(v));
};

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v);

interface ForgeTransaction {
  transactionType?: unknown;
  contractName?: unknown;
  contractAddress?: unknown;
  additionalContracts?: { address?: unknown }[];
  transaction?: {
    from?: unknown;
    to?: unknown;
    input?: unknown;
    value?: unknown;
    nonce?: unknown;
    gas?: unknown;
    chainId?: unknown;
  };
}

/** Reads and checks a Foundry dry-run file. Throws on anything that is not an ARL deployment.
 * `artifacts` is the build the creations must match: the current one, except in tests that read
 * runs made from an earlier release. */
export function parseRun(
  json: unknown,
  artifacts: DeployArtifacts = DEPLOY_ARTIFACTS,
  zk: ZkArtifacts = ZK_DEPLOY_ARTIFACTS,
): DeployRun {
  const run = json as { transactions?: unknown; chain?: unknown };
  if (!Array.isArray(run.transactions) || run.transactions.length === 0) {
    fail("the file has no transactions");
  }
  const chainId = typeof run.chain === "number" ? run.chain : fail("the file has no chain id");
  assertAllowedChain(chainId);

  let from: Address | undefined;
  let nextNonce: number | undefined;
  const steps = (run.transactions as ForgeTransaction[]).map((t, index): DeployStep => {
    const tx = t.transaction ?? fail(`transaction ${String(index + 1)}: missing`);
    if (tx.chainId !== undefined && hexNumber(tx.chainId, "chainId") !== chainId) {
      fail(`transaction ${String(index + 1)}: another chain`);
    }
    if (typeof tx.from !== "string" || !isAddress(tx.from)) fail("a transaction has no sender");
    const sender = getAddress(tx.from);
    from ??= sender;
    if (sender !== from) fail(`transaction ${String(index + 1)}: another sender`);
    if (tx.value !== undefined && hexNumber(tx.value, "value") !== 0) {
      fail(`transaction ${String(index + 1)}: sends ETH`);
    }
    const nonce = hexNumber(tx.nonce, "nonce");
    if (nextNonce !== undefined && nonce !== nextNonce) {
      fail(`transaction ${String(index + 1)}: nonces are not consecutive`);
    }
    nextNonce = nonce + 1;
    if (!isHex(tx.input) || tx.input.length <= 2) fail(`transaction ${String(index + 1)}: no data`);
    const gas = tx.gas === undefined ? undefined : BigInt(hexNumber(tx.gas, "gas"));
    const base = { index, from, nonce, data: tx.input, gas };

    if (t.transactionType === "CREATE2") {
      if (
        typeof tx.to !== "string" ||
        !isAddress(tx.to) ||
        getAddress(tx.to) !== CREATE2_DEPLOYER
      ) {
        fail(`transaction ${String(index + 1)}: not sent to the CREATE2 deployer`);
      }
      const name = t.contractName;
      if (typeof name !== "string" || !Object.hasOwn(zk.libraries, name)) {
        fail(`transaction ${String(index + 1)}: creates an unknown library`);
      }
      const library = name as ZkLibrary;
      const pinned = zk.libraries[library];
      if ((tx.input.length - 2) / 2 !== 32 + pinned.creationSize) {
        fail(`transaction ${String(index + 1)}: ${library} has the wrong length`);
      }
      if (slice(tx.input, 0, 32) !== ZERO_SALT) {
        fail(`transaction ${String(index + 1)}: ${library} does not use the zero salt`);
      }
      if (keccak256(slice(tx.input, 32)) !== pinned.creationHash) {
        fail(`transaction ${String(index + 1)}: ${library} code is not the ARL build`);
      }
      const address = zkLibraryAddress(library, zk);
      if (typeof t.contractAddress === "string" && getAddress(t.contractAddress) !== address) {
        fail(`transaction ${String(index + 1)}: address does not follow from the library code`);
      }
      return { kind: "library", library, address, ...base };
    }

    if (t.transactionType === "CREATE" && t.contractName === "HonkVerifier") {
      if (tx.to !== null && tx.to !== undefined)
        fail(`transaction ${String(index + 1)}: not a creation`);
      const pinned = zk.HonkVerifier;
      if ((tx.input.length - 2) / 2 !== pinned.creationSize) {
        fail(`transaction ${String(index + 1)}: HonkVerifier has the wrong length`);
      }
      // The code names its two libraries by address. Each must be the address that follows from
      // the pinned library code; with those bytes blanked, the rest must be the ARL build.
      let blanked: string = tx.input;
      const linked: Partial<Record<ZkLibrary, Address>> = {};
      for (const link of pinned.links) {
        const at = 2 + link.start * 2;
        const address = getAddress(`0x${blanked.slice(at, at + 40)}`);
        if (address !== zkLibraryAddress(link.library, zk)) {
          fail(
            `transaction ${String(index + 1)}: HonkVerifier is linked to another ${link.library}`,
          );
        }
        linked[link.library] = address;
        blanked = blanked.slice(0, at) + "0".repeat(40) + blanked.slice(at + 40);
      }
      if (keccak256(blanked as Hex) !== pinned.blankedCreationHash) {
        fail(`transaction ${String(index + 1)}: HonkVerifier code is not the ARL build`);
      }
      const address = getContractAddress({ from, nonce: BigInt(nonce) });
      if (typeof t.contractAddress === "string" && getAddress(t.contractAddress) !== address) {
        fail(`transaction ${String(index + 1)}: address does not follow from sender and nonce`);
      }
      return {
        kind: "verifier",
        address,
        libraries: linked as Record<ZkLibrary, Address>,
        ...base,
      };
    }

    if (t.transactionType === "CREATE") {
      if (tx.to !== null && tx.to !== undefined)
        fail(`transaction ${String(index + 1)}: not a creation`);
      const name = t.contractName;
      if (typeof name !== "string" || !(name in artifacts)) {
        fail(`transaction ${String(index + 1)}: creates an unknown contract`);
      }
      const contract = name as keyof typeof DEPLOY_ARTIFACTS;
      const artifact =
        artifacts[contract] ??
        fail(`transaction ${String(index + 1)}: creates an unknown contract`);
      const size = artifact.creationSize;
      if ((tx.input.length - 2) / 2 < size)
        fail(`transaction ${String(index + 1)}: code too short`);
      if (keccak256(slice(tx.input, 0, size)) !== artifact.creationHash) {
        fail(`transaction ${String(index + 1)}: ${contract} code is not the ARL build`);
      }
      const rest = (tx.input.length - 2) / 2 === size ? "0x" : slice(tx.input, size);
      let args: readonly unknown[];
      try {
        args = decodeAbiParameters(artifact.constructorInputs as never, rest);
      } catch {
        fail(`transaction ${String(index + 1)}: unreadable ${contract} arguments`);
      }
      const address = getContractAddress({ from, nonce: BigInt(nonce) });
      if (typeof t.contractAddress === "string" && getAddress(t.contractAddress) !== address) {
        fail(`transaction ${String(index + 1)}: address does not follow from sender and nonce`);
      }
      return { kind: "create", contract, address, args, ...base };
    }

    if (t.transactionType === "CALL") {
      if (typeof tx.to !== "string" || !isAddress(tx.to))
        fail(`transaction ${String(index + 1)}: no target`);
      const factory = getAddress(tx.to);
      if (chainId !== LOCAL_CHAIN_ID && factory !== SAFE_FACTORY_V150) {
        fail(`transaction ${String(index + 1)}: calls a contract that is not the Safe factory`);
      }
      let singleton: Address;
      let initializer: Hex;
      try {
        const call = decodeFunctionData({ abi: factoryAbi, data: tx.input });
        [singleton, initializer] = [call.args[0], call.args[1]];
      } catch {
        fail(`transaction ${String(index + 1)}: not a Safe creation`);
      }
      if (chainId !== LOCAL_CHAIN_ID && !SAFE_SINGLETONS_V150.includes(getAddress(singleton))) {
        fail(`transaction ${String(index + 1)}: not a canonical Safe v1.5.0 singleton`);
      }
      let owners: readonly Address[];
      let threshold: bigint;
      try {
        const setup = decodeFunctionData({ abi: safeAbi, data: initializer });
        [owners, threshold] = [setup.args[0], setup.args[1]];
      } catch {
        fail(`transaction ${String(index + 1)}: unreadable Safe setup`);
      }
      if (threshold < 1n || threshold > BigInt(owners.length)) {
        fail(`transaction ${String(index + 1)}: Safe threshold out of range`);
      }
      const created = t.additionalContracts?.[0]?.address;
      return {
        kind: "safe",
        factory,
        singleton: getAddress(singleton),
        owners: owners.map((o) => getAddress(o)),
        threshold,
        safe: typeof created === "string" && isAddress(created) ? getAddress(created) : undefined,
        ...base,
      };
    }
    fail(`transaction ${String(index + 1)}: unsupported type`);
  });
  return { chainId, from: from ?? fail("no sender"), steps };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const date = (s: unknown) => new Date(Number(s) * 1000).toISOString().slice(0, 10);

/** What a step does, in one or two plain sentences, shown before it is signed. */
export function describeStep(step: DeployStep): { title: string; detail: string } {
  if (step.kind === "safe") {
    return {
      title: `Create a Safe (${String(step.threshold)} of ${String(step.owners.length)})`,
      detail: `Creates a Safe multisig owned by ${step.owners.map(short).join(", ")}; ${String(step.threshold)} of them must sign each of its transactions. No tokens move and your address gets no role.`,
    };
  }
  if (step.kind === "library") {
    return {
      title: `Create the verifier library ${step.library}`,
      detail: `Creates ${step.library}, a library of the zero-knowledge verifier, at ${short(step.address)} through the canonical CREATE2 deployer. The address follows from the library code alone. It holds no tokens and nobody controls it.`,
    };
  }
  if (step.kind === "verifier") {
    return {
      title: "Create the zero-knowledge verifier",
      detail: `Creates the verifier of the anonymous-signal proofs (generated by Barretenberg from the ARL circuit), linked to its libraries at ${Object.values(step.libraries).map(short).join(" and ")}. It only checks proofs: it holds no tokens and has no owner.`,
    };
  }
  const a = step.args;
  switch (step.contract) {
    case "ARLVestingWallet":
      return {
        title: "Create a vesting wallet",
        detail: `Creates a vesting wallet for ${short(String(a[0]))}: nothing vests before ${date(a[2])}, then linearly until ${date(a[3])} (grant date ${date(a[1])}). It holds no tokens until the token is created.`,
      };
    case "ARLTimelock":
      return {
        title: "Create the treasury timelock",
        detail: `Creates the treasury timelock with a delay of ${String(Number(a[0]) / 3600)} hours. Proposer and executor: ${(a[1] as string[]).map(short).join(", ")}; cancel-only guardian: ${short(String(a[3]))}.`,
      };
    case "ARLToken":
      return {
        title: "Create the ARL token",
        detail:
          "Creates the ARL token and mints the fixed 21,000,000 ARL once, to the eleven allocation holders. Nothing is minted to your address and the token has no owner.",
      };
    case "ARLJobs":
      return {
        title: "Create the jobs escrow",
        detail: `Creates the ERC-8183 jobs escrow, paid in the token ${short(String(a[0]))}. Clients fund jobs into it and it pays the provider or refunds the client as the job's evaluator decides. It has no owner and holds no tokens until a job is funded.`,
      };
    case "ARLVerifiedEvaluator":
      return {
        title: "Create the verified evaluator",
        detail: `Creates the staked validator committee for the escrow ${short(String(a[0]))}. Disputes go to the arbiter Safe ${short(String(a[1]))}; every challenge window is at least ${String(Number(a[2]) / 3600)} hours and every bond at least ${formatUnits(BigInt(String(a[3])), 18)} tokens. It has no owner.`,
      };
    case "ComputePayment":
      return {
        title: "Create the compute payment contract",
        detail: `Creates the per-second payment streams, paid in the token ${short(String(a[0]))}. A client escrows a stream to a compute provider and either side can stop it. It has no owner and holds no tokens until a stream is opened.`,
      };
    case "ARLAnonymousSignal":
      return {
        title: "Create the anonymous signals contract",
        detail: `Creates the anonymous signals contract with the verifier ${short(String(a[0]))}. Members of a group signal (vote, attest) once per poll without revealing which member they are. It has no owner and holds no tokens; the admin of each group is the account that creates it, and your address gets no role.`,
      };
    case "ARLStakingRewards":
      return {
        title: "Create the staking rewards contract",
        detail: `Creates staking for the token ${short(String(a[0]))}, with rewards in ${short(String(a[1]))} over periods of ${String(Number(a[3]) / 86_400)} days. Only ${short(String(a[2]))} can fund a reward period; nothing is funded or minted now, and it has no owner.`,
      };
  }
}

/**
 * Path of a prepared run published with the app (under `public/plans/`), selected with
 * `?plan=<name>`. Only plain names are accepted, so the file always comes from this site; its
 * content is still untrusted and goes through `parseRun`.
 */
export function publishedPlanPath(name: string, basePath = ""): string {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) fail("the plan name is not valid");
  return `${basePath}/plans/${name}.json`;
}

/** Circle's native USDC on Base Mainnet: the payment token of the second jobs escrow. */
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * After every transaction is signed: the command that writes the verified deployment record
 * from this run file (`packages/deploy/src/record-cli.ts`). Nothing counts as deployed until it
 * passes, and the Safe addresses for the next plan come only from the Safes record it writes.
 */
export function recordCommand(
  run: DeployRun,
  runFile: string,
): {
  kind: "safes" | "arl" | "jobs" | "services" | "arbiter" | "signal";
  command: string;
} {
  const rpc =
    run.chainId === LOCAL_CHAIN_ID ? "<local-rpc-url> --local-anvil" : "https://mainnet.base.org";
  const isJobs = (s: DeployStep) =>
    s.kind === "create" && (s.contract === "ARLJobs" || s.contract === "ARLVerifiedEvaluator");
  if (run.steps.some(isJobs)) {
    if (!run.steps.every(isJobs)) fail("the run mixes the jobs contracts with other steps");
    // The escrow paid in USDC is recorded apart from the one paid in ARL. A run that creates only
    // an evaluator names its escrow, not the escrow's token; DeployMainnetVerifiedJobs passes the
    // stake token explicitly only when it differs from the payment token (bonds in ARL for the
    // escrow paid in USDC) and address(0) otherwise.
    const zero = "0x0000000000000000000000000000000000000000";
    const usdc = run.steps.some(
      (s) =>
        s.kind === "create" &&
        ((s.contract === "ARLJobs" &&
          String(s.args[0]).toLowerCase() === BASE_USDC.toLowerCase()) ||
          (s.contract === "ARLVerifiedEvaluator" &&
            !run.steps.some((t) => t.kind === "create" && t.contract === "ARLJobs") &&
            String(s.args[6]).toLowerCase() !== zero)),
    );
    return {
      kind: "jobs",
      command: `node packages/deploy/src/jobs-record-cli.ts ${runFile} ${rpc} contracts/deploy/deployments/${String(run.chainId)}-jobs${usdc ? "-usdc" : ""}.json`,
    };
  }
  // Compute payment and staking rewards (DeployMainnetServices) have their own record.
  const isService = (s: DeployStep) =>
    s.kind === "create" && (s.contract === "ComputePayment" || s.contract === "ARLStakingRewards");
  if (run.steps.some(isService)) {
    if (!run.steps.every(isService)) fail("the run mixes the network services with other steps");
    return {
      kind: "services",
      command: `node packages/deploy/src/services-record-cli.ts ${runFile} ${rpc} contracts/deploy/deployments/${String(run.chainId)}-services.json`,
    };
  }
  // The anonymous signals contract with its verifier and libraries (DeployMainnetSignal).
  const isSignal = (s: DeployStep) =>
    s.kind === "library" ||
    s.kind === "verifier" ||
    (s.kind === "create" && s.contract === "ARLAnonymousSignal");
  if (run.steps.some(isSignal)) {
    if (!run.steps.every(isSignal)) fail("the run mixes the anonymous signals with other steps");
    return {
      kind: "signal",
      command: `node packages/deploy/src/signal-record-cli.ts ${runFile} ${rpc} contracts/deploy/deployments/${String(run.chainId)}-signal.json`,
    };
  }
  // A single Safe is the evaluator's arbiter (CreateArbiterSafe), not the twelve allocation Safes.
  if (run.steps.length === 1 && run.steps[0]?.kind === "safe") {
    const safe = run.steps[0].safe ?? "<safe>";
    return {
      kind: "arbiter",
      command: `cast call ${safe} "getOwners()(address[])" --rpc-url ${rpc.split(" ")[0]} && cast call ${safe} "getThreshold()(uint256)" --rpc-url ${rpc.split(" ")[0]}`,
    };
  }
  const kind = run.steps.every((s) => s.kind === "safe") ? "safes" : "arl";
  if (kind === "arl" && run.steps.some((s) => s.kind !== "create")) {
    fail("the run mixes Safe creations and contract creations");
  }
  const out = `contracts/deploy/deployments/${String(run.chainId)}${kind === "safes" ? "-safes" : ""}.json`;
  return {
    kind,
    command: `node packages/deploy/src/record-cli.ts ${kind} ${runFile} ${rpc} ${out}`,
  };
}

/** Checks the connected wallet against a step just before it is sent. */
export function checkBeforeSend(
  step: DeployStep,
  wallet: { account: Address; chainId: number; nonce: number },
  runChainId: number,
): string | undefined {
  if (wallet.chainId !== runChainId) {
    return `switch the wallet to ${runChainId === LOCAL_CHAIN_ID ? "the local chain" : "Base"}`;
  }
  if (getAddress(wallet.account) !== step.from) {
    return `connect ${short(step.from)}: this plan was prepared for that address`;
  }
  if (wallet.nonce !== step.nonce) {
    return `the wallet's next transaction is #${String(wallet.nonce)}, the plan expects #${String(step.nonce)}; the plan must be prepared again`;
  }
  return undefined;
}
