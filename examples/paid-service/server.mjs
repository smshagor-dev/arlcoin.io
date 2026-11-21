// A paid HTTP service on ARL Protocol, in one file.
//
// A caller asks for the work. Without a paid job the service answers 402 with its terms; the
// caller opens and funds a job that matches them (the SDK's `payVerified` does it in one call)
// and asks again. The service does the work, answers, and submits the hash of its result on
// chain. Staked validators re-run the job in a container, and the escrow pays the service only
// when they get the same result.
//
//   npm install
//   npm run check                      # no key, no network: prints what the service sells
//   ARL_SERVICE_KEY=0x... ARL_SPEC_URL=https://.../spec.json npm start
//
// Two things make it your service: spec.json (the job a validator can re-run) and `work` below
// (the same job, done by you). They must produce the same files, byte for byte.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";

import { canonicalHash, payOnProof } from "arl-protocol-sdk";
import { createPublicClient, createWalletClient, http, isAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// --- What the service sells -----------------------------------------------------------------

/** The job, as a validator re-runs it. Its hash is committed on chain with every job. */
const spec = JSON.parse(readFileSync(new URL("./spec.json", import.meta.url), "utf8"));
const specHash = canonicalHash(spec);

/**
 * The work. Return every file the spec lists under `outputs`, with exactly the bytes the spec's
 * command writes to /out, and whatever the caller should receive as the answer.
 */
async function work() {
  const summary = "passed=3 failed=0\n";
  return {
    outputs: { "summary.txt": Buffer.from(summary) },
    answer: { summary: summary.trim() },
  };
}

/** The hash a validator computes after re-running the spec: the exit code and each output file. */
function deliverableOf(outputs) {
  return canonicalHash({
    version: "arl-reexec-result/1",
    spec_hash: specHash,
    exit_code: spec.expected_exit_code ?? 0,
    timed_out: false,
    outputs: spec.outputs.map((path) => {
      const bytes = outputs[path];
      if (!bytes)
        throw new Error(`work() did not return ${path}, which spec.json lists as an output`);
      return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    }),
  });
}

// --- Settings --------------------------------------------------------------------------------

/** ARL's validators on Base Mainnet. Any staked validators can be named instead. */
const DEFAULT_COMMITTEE = [
  "0x7E8e18bf48F07B82F64b846b0d509ad79FD86244",
  "0x394846C9E1161A07471F9e8baEda77E4AEa85fa1",
  "0xdAa1EFD5E765Baf67D8013C1c67039945819B760",
];

const env = process.env;
// Validators lock a bond of 100 ARL for a job and take it only when the budget is at least that.
const price = parseUnits(env.ARL_PRICE ?? "100", 18);
const committee = (env.ARL_COMMITTEE ?? DEFAULT_COMMITTEE.join(","))
  .split(",")
  .map((a) => a.trim())
  .filter((a) => a !== "");
const port = Number(env.PORT ?? "8787");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (committee.length < 3 || committee.some((a) => !isAddress(a))) {
  fail("ARL_COMMITTEE must list at least three validator addresses, separated by commas.");
}

if (process.argv.includes("--check")) {
  // What a caller and a validator will see, computed without a key and without the network.
  const done = await work();
  console.log(
    JSON.stringify(
      {
        specHash,
        deliverable: deliverableOf(done.outputs),
        priceArl: (price / 10n ** 18n).toString(),
        committee,
        answer: done.answer,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const key = (env.ARL_SERVICE_KEY ?? "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  fail(
    "Set ARL_SERVICE_KEY to the private key of the account that is paid (0x and 64 hex characters).",
  );
}
const specUri = (env.ARL_SPEC_URL ?? "").trim();
if (!/^(https|ipfs):\/\/\S+$/.test(specUri)) {
  fail("Set ARL_SPEC_URL to the public https:// or ipfs:// link where validators fetch spec.json.");
}

const account = privateKeyToAccount(key);
const transport = http(env.ARL_RPC ?? "https://mainnet.base.org");
const clients = {
  publicClient: createPublicClient({ chain: base, transport }),
  walletClient: createWalletClient({ account, chain: base, transport }),
};

// --- The service -----------------------------------------------------------------------------

const service = payOnProof(
  {
    clients,
    offer: {
      chainId: base.id,
      provider: account.address,
      specUri,
      specHash,
      budget: price,
      committee,
      threshold: Math.floor(committee.length / 2) + 1,
    },
    onError: (error, jobId) => {
      console.error(
        `job ${String(jobId)}: the result was not submitted (${error?.message ?? error})`,
      );
    },
  },
  async (_request, job) => {
    const done = await work();
    console.log(`job ${String(job.jobId)} from ${job.client}: served`);
    return {
      body: JSON.stringify(done.answer),
      deliverable: deliverableOf(done.outputs),
      headers: { "content-type": "application/json" },
    };
  },
);

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
      ),
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await service(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the service failed" }));
  }
}).listen(port, () => {
  console.log(`Paid service of ${account.address} on http://localhost:${String(port)}`);
  console.log(`Price ${(price / 10n ** 18n).toString()} ARL per call, spec ${specHash}`);
});
