// What the status page checks and how each answer is read. Everything is read in the browser, from
// public endpoints: Base through public RPCs, and the Agent API of this site. A check is "ok" only
// when its own answer says so; a failed read is reported as no answer, never guessed.
import { ARL_AGENT } from "./hire.ts";
import { SITE } from "./site.ts";

/** The public Base Mainnet endpoint the site may call from a browser (public/_headers). */
export const STATUS_RPCS = ["https://mainnet.base.org"] as const;

/** The contracts of docs/mainnet-services.md. */
export const STATUS_CONTRACTS = [
  { name: "ARL token", address: SITE.mainnet.token },
  { name: "Job escrow (ARL)", address: "0x9aE99bF9a59aF47E81346B7c0b93Cd2B610455fC" },
  { name: "Job escrow (USDC)", address: "0xE3eA0EAEc3Cf9DA2d0856A0f784A4B1671AeFD04" },
  { name: "Verified evaluator (ARL)", address: "0x0D160C869bd2a7AaEDd29e11fc60fdAEf21c3E28" },
  { name: "Verified evaluator (USDC)", address: "0x7A00D45598Da7C13feEA8962fc1110FC4Db4D850" },
  { name: "Compute payment", address: "0x1bFE932896fdd32175836a7364dcaf53d49EE464" },
  { name: "Anonymous signals", address: "0x87C05cB26FFB56181ca561Dd9c11DD5D9d2ea2d4" },
] as const;

export interface ValidatorLine {
  token: string;
  validator: string;
  stake: string;
  accepted: number;
  slashes: number;
}

export interface NetworkState {
  checkedAt: number;
  /** `time` is the head block's own timestamp, in seconds; null when only its number is known. */
  chain: { ok: true; block: number; time: number | null; ms: number } | { ok: false };
  /** `null` when the chain could not be asked, so nothing is known about the contract. */
  contracts: { ok: boolean | null }[];
  api: { ok: true; ms: number } | { ok: false };
  /** The block the API's verified history reaches; null when the API did not answer. */
  history: { block: number; minutesBehind: number | null } | null;
  validators: ValidatorLine[] | null;
  agent: { registered: boolean; completed: number; rejected: number } | null;
}

type Fetch = typeof fetch;

interface RpcAnswer {
  id: number;
  result?: unknown;
}

/**
 * Minutes between two blocks, from their own timestamps (seconds), never negative. The distance in
 * blocks is not used: how long a block takes is the chain's to decide and has changed before.
 */
export function minutesBehind(headTime: number, blockTime: number): number {
  return Math.max(0, Math.round((headTime - blockTime) / 60));
}

const quantity = (v: unknown): number | null =>
  typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? Number(BigInt(v)) : null;

/** A contract answers when the chain returns code for its address. */
export function hasCode(result: unknown): boolean {
  return typeof result === "string" && /^0x[0-9a-fA-F]+$/.test(result) && result.length > 2;
}

async function json(doFetch: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return res.json();
}

/** The head block and each contract's code, in one batch, from the first endpoint that answers. */
async function readChain(doFetch: Fetch): Promise<Pick<NetworkState, "chain" | "contracts">> {
  const batch = [
    { jsonrpc: "2.0", id: 0, method: "eth_getBlockByNumber", params: ["latest", false] },
    ...STATUS_CONTRACTS.map((c, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "eth_getCode",
      params: [c.address, "latest"],
    })),
  ];
  for (const url of STATUS_RPCS) {
    const started = Date.now();
    try {
      const body = await json(doFetch, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      });
      if (!Array.isArray(body)) continue;
      const byId = new Map((body as RpcAnswer[]).map((a) => [a.id, a.result]));
      const head = record(byId.get(0));
      const number = quantity(head?.number);
      if (number === null) continue;
      return {
        chain: {
          ok: true,
          block: number,
          time: quantity(head?.timestamp),
          ms: Date.now() - started,
        },
        contracts: STATUS_CONTRACTS.map((_, i) => ({ ok: hasCode(byId.get(i + 1)) })),
      };
    } catch {
      // The next endpoint is asked.
    }
  }
  return { chain: { ok: false }, contracts: STATUS_CONTRACTS.map(() => ({ ok: null })) };
}

/** The highest block the API's endpoints report (GET /api/v1/health). */
async function headFromApi(doFetch: Fetch, base: string): Promise<NetworkState["chain"]> {
  const started = Date.now();
  try {
    const body = record(await json(doFetch, `${base}/api/v1/health`));
    const rpcs = Array.isArray(body?.rpcs) ? body.rpcs : [];
    let head = 0;
    for (const entry of rpcs) {
      const r = record(entry);
      if (r?.ok === true && typeof r.block === "string" && /^[0-9]+$/.test(r.block)) {
        head = Math.max(head, Number(r.block));
      }
    }
    return head > 0
      ? { ok: true, block: head, time: null, ms: Date.now() - started }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** The timestamp of `block`, in seconds; null when the chain could not be asked. */
async function blockTime(doFetch: Fetch, block: number): Promise<number | null> {
  for (const url of STATUS_RPCS) {
    try {
      const body = record(
        await json(doFetch, url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getBlockByNumber",
            params: [`0x${block.toString(16)}`, false],
          }),
        }),
      );
      const time = quantity(record(body?.result)?.timestamp);
      if (time !== null) return time;
    } catch {
      // The next endpoint is asked.
    }
  }
  return null;
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One reading of everything the page shows. Never throws: a failed part is reported as such. */
export async function readStatus(doFetch: Fetch = fetch, base = ""): Promise<NetworkState> {
  const apiStarted = Date.now();
  const [direct, validatorsBody, agentBody] = await Promise.all([
    readChain(doFetch),
    json(doFetch, `${base}/api/v1/validators`).catch(() => null),
    json(doFetch, `${base}/api/v1/agents/${ARL_AGENT.id}`).catch(() => null),
  ]);
  const apiMs = Date.now() - apiStarted;
  // When the browser could not reach Base itself, the head comes from the API's own health check.
  const chain = direct.chain.ok ? direct : { ...direct, chain: await headFromApi(doFetch, base) };

  const validatorsDoc = record(validatorsBody);
  const list = Array.isArray(validatorsDoc?.validators) ? validatorsDoc.validators : null;
  const validators =
    list === null
      ? null
      : list.flatMap((entry): ValidatorLine[] => {
          const v = record(entry);
          if (!v || typeof v.validator !== "string" || typeof v.stake !== "string") return [];
          if (!/^[0-9]+$/.test(v.stake)) return [];
          return [
            {
              token: typeof v.token === "string" ? v.token : "ARL",
              validator: v.validator,
              stake: v.stake,
              accepted: count(v.accepted),
              slashes: count(v.slashes),
            },
          ];
        });

  const blockText = validatorsDoc?.block;
  const block =
    typeof blockText === "string" && /^[0-9]+$/.test(blockText) ? Number(blockText) : null;
  const agentDoc = record(agentBody);
  // How far behind the history is, from the two blocks' own timestamps.
  const headTime = chain.chain.ok ? chain.chain.time : null;
  const historyTime = block === null || headTime === null ? null : await blockTime(doFetch, block);

  return {
    checkedAt: Date.now(),
    ...chain,
    api: validatorsDoc || agentDoc ? { ok: true, ms: apiMs } : { ok: false },
    history:
      block === null
        ? null
        : {
            block,
            minutesBehind:
              headTime === null || historyTime === null
                ? null
                : minutesBehind(headTime, historyTime),
          },
    validators,
    agent: agentDoc
      ? {
          registered: agentDoc.registered === true,
          completed: count(agentDoc.completed),
          rejected: count(agentDoc.rejected),
        }
      : null,
  };
}
