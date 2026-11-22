// The ARL MCP server over Streamable HTTP (MCP 2025-03-26 and later), stateless: every POST
// carries one JSON-RPC message and gets one JSON answer, so it runs as a Cloudflare Pages Function
// at arlcoin.io/mcp with no session store. The same `handle` answers as over stdio, with the same
// read-only tools: no key is held and no transaction is ever sent. Notifications get 202 and no
// body; GET (a server-to-client stream) is not offered and answers 405, as the transport allows.

import { MAX_BODY_BYTES } from "./http.ts";
import { handle, toJson, type Tool } from "./server.ts";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "mcp-protocol-version",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

const json = (body: unknown, status = 200) =>
  new Response(`${toJson(body)}\n`, { status, headers: HEADERS });

export async function handleMcpHttp(request: Request, tools: readonly Tool[]): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...HEADERS,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers":
          "content-type, accept, mcp-protocol-version, mcp-session-id",
      },
    });
  }
  if (request.method !== "POST") {
    return json({ error: "use POST with MCP JSON-RPC (Streamable HTTP, stateless)" }, 405);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "request too large" },
    });
  }
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  if (Array.isArray(message)) {
    return json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "send one JSON-RPC message per request" },
    });
  }
  const response = await handle(message, tools);
  if (response === null) return new Response(null, { status: 202, headers: HEADERS });
  return json(response);
}
