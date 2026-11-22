/* eslint-disable no-console -- the runner prints its report to the job log */
// One run of the buyer agent from the command line, for a scheduled runner (GitHub Actions,
// .github/workflows/magnet-agent.yml). Reads and writes its history at STATE_FILE so each run reads
// only new blocks.
//
// Environment:
//   AGENT_KEY    the agent's private key (a secret of the runner; never printed)
//   RPC_URLS     optional, comma-separated Base Mainnet endpoints
//   STATE_FILE   optional, default .magnet-state/history.json
//   PAUSED       "true" exits without doing anything

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createPublicClient, createWalletClient, fallback, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { AGENT_FROM_BLOCK, runOnce } from "./agent.ts";
import { EXCLUDED } from "./excluded.ts";
import { loadHistory } from "./history.ts";

const key = process.env.AGENT_KEY ?? "";
if (process.env.PAUSED === "true") {
  console.log("paused");
  process.exit(0);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  // Not switched on yet: the owners set the key and the allowance first. Not an error.
  console.log("AGENT_KEY is not set: nothing to do");
  process.exit(0);
}

const urls = (
  process.env.RPC_URLS ??
  "https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org"
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const transport = fallback(urls.map((u) => http(u, { timeout: 20_000 })));
const account = privateKeyToAccount(key as `0x${string}`);
// The Base chain config adds OP Stack formatters that the SDK types do not carry; same client.
const publicClient = createPublicClient({ chain: base, transport }) as unknown as PublicClient;
const walletClient = createWalletClient({ account, chain: base, transport });

const stateFile = process.env.STATE_FILE ?? ".magnet-state/history.json";
// Read it in one step (no existence check first): a missing or unreadable file starts fresh.
let stored: string | undefined;
try {
  stored = readFileSync(stateFile, "utf8");
} catch {
  stored = undefined;
}
const history = loadHistory(stored, account.address, AGENT_FROM_BLOCK);

const report = await runOnce(
  { publicClient, walletClient },
  {
    excluded: EXCLUDED,
    history,
    log: (l) => {
      console.log(l);
    },
  },
);
if (report.history) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(report.history));
}
console.log(
  JSON.stringify(
    {
      agent: account.address,
      cursor: report.history?.cursor,
      finalized: report.finalized.map(String),
      funded: report.funded.map(String),
      opened: report.opened.map((o) => ({
        jobId: String(o.jobId),
        agentId: String(o.agentId),
        provider: o.provider,
        budget: String(o.budget),
      })),
      skipped: report.skipped,
    },
    null,
    2,
  ),
);
