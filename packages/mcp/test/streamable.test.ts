import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SERVER_INFO, arlTools, handleMcpHttp, type ChainReader } from "../src/index.ts";

const chain: ChainReader = {
  getChainId: () => Promise.resolve(8453),
  getBlock: () => Promise.resolve({ number: 100n, timestamp: 1_800_000_000n }),
  readContract: () => Promise.resolve({ phase: 1 }),
};
const tools = arlTools({ chain });

const post = (body: string) =>
  handleMcpHttp(
    new Request("https://arlcoin.io/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    }),
    tools,
  );
const rpc = (method: string, params: unknown = {}) =>
  post(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));

describe("MCP over Streamable HTTP", () => {
  it("initializes and names the server", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    assert.equal(body.result.serverInfo.name, SERVER_INFO.name);
  });

  it("lists the same tools as the stdio server", async () => {
    const body = (await (await rpc("tools/list")).json()) as {
      result: { tools: { name: string }[] };
    };
    assert.deepEqual(
      body.result.tools.map((t) => t.name),
      tools.map((t) => t.name),
    );
  });

  it("answers a notification with 202 and no body", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  });

  it("refuses GET, batches, bad JSON and oversized bodies", async () => {
    const get = await handleMcpHttp(new Request("https://arlcoin.io/mcp"), tools);
    assert.equal(get.status, 405);
    const batch = (await (await post("[]")).json()) as { error: { code: number } };
    assert.equal(batch.error.code, -32600);
    const bad = (await (await post("{")).json()) as { error: { code: number } };
    assert.equal(bad.error.code, -32700);
    const big = (await (await post(`"${"x".repeat(2_000_000)}"`)).json()) as {
      error: { message: string };
    };
    assert.equal(big.error.message, "request too large");
  });

  it("answers CORS preflight", async () => {
    const res = await handleMcpHttp(
      new Request("https://arlcoin.io/mcp", { method: "OPTIONS" }),
      tools,
    );
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  });
});
