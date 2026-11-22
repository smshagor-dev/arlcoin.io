// Cloudflare Pages Function: arlcoin.io/mcp, the ARL MCP server over Streamable HTTP, stateless
// (packages/mcp/src/streamable.ts). Read-only: no key, no transaction is ever sent.
import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";

import { handleMcpHttp } from "../packages/mcp/src/streamable.ts";
import { arlTools } from "../packages/mcp/src/tools.ts";

const chain = createPublicClient({
  chain: base,
  // retryCount 0: the fallback moves on to the next endpoint (see functions/api/v1).
  transport: fallback(
    ["https://base.drpc.org", "https://base-rpc.publicnode.com", "https://mainnet.base.org"].map(
      (url) => http(url, { timeout: 3000, retryCount: 0 }),
    ),
  ),
});
const tools = arlTools({ chain });

export function onRequest({ request }) {
  return handleMcpHttp(request, tools);
}
