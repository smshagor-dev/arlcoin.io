// One entry per tool in the "Works where your agents work" network (src/site/AgentNetwork.tsx).
// Each node there links to /connect#<id>, where the tool's fastest way in is a single button:
// an install link the tool itself opens (Cursor, VS Code), the tool's own connector settings
// (Claude, ChatGPT), or one command. Nothing here ever asks for a key.

export const MCP_URL = "https://arlcoin.io/mcp";

const CURSOR_CONFIG = btoa(JSON.stringify({ url: MCP_URL }));
const VSCODE_INSTALL = `vscode:mcp/install?${encodeURIComponent(
  JSON.stringify({ name: "arl", type: "http", url: MCP_URL }),
)}`;

export interface ConnectLink {
  label: string;
  href: string;
}

export interface ConnectEntry {
  id: string;
  label: string;
  via: string;
  /** What the button does, in one line. */
  lead: string;
  /** The one-click way in, when the tool has one. */
  primary?: ConnectLink;
  secondary?: ConnectLink;
  steps?: readonly string[];
  code?: string;
}

const AGENT_API = `curl https://arlcoin.io/api/v1/agents/1221687         # an agent's passport
curl https://arlcoin.io/api/v1/agents/1221687/score   # its verified score
curl https://arlcoin.io/api/v1/jobs/ARL/1             # a job, read at a named block`;

export const CONNECT: readonly ConnectEntry[] = [
  {
    id: "claude",
    label: "Claude",
    via: "MCP",
    lead: "Add ARL as a connector in Claude on the web or desktop, or with one command in Claude Code.",
    primary: { label: "Open Claude connectors", href: "https://claude.ai/settings/connectors" },
    steps: [
      "Settings → Connectors → Add custom connector.",
      `Name: ARL. URL: ${MCP_URL}. No key is needed.`,
    ],
    code: `claude mcp add --transport http arl ${MCP_URL}`,
  },
  {
    id: "openai",
    label: "OpenAI",
    via: "MCP",
    lead: "Use ARL as a remote MCP server in ChatGPT developer mode or from the OpenAI API.",
    primary: { label: "Open ChatGPT connectors", href: "https://chatgpt.com/#settings/Connectors" },
    steps: [
      "Settings → Apps & Connectors → Advanced settings → turn on Developer mode.",
      `Create a connector with the URL ${MCP_URL} and no authentication.`,
    ],
    code: `// OpenAI Responses API
tools: [{ type: "mcp", server_label: "arl", server_url: "${MCP_URL}", require_approval: "never" }]`,
  },
  {
    id: "gemini",
    label: "Gemini",
    via: "MCP · A2A",
    lead: "Add ARL to Gemini CLI with one command, or reach it over A2A through the agent card.",
    secondary: { label: "A2A agent card", href: "/.well-known/agent-card.json" },
    code: `gemini mcp add --transport http arl ${MCP_URL}`,
  },
  {
    id: "xspacesi",
    label: "XSpaceSI",
    via: "Agent API",
    lead: "Any model that can call an HTTP tool reads ARL through the Agent API: plain JSON, no key.",
    secondary: {
      label: "Agent API reference",
      href: "https://github.com/armanalabsai/arlcoin.io/blob/main/docs/agent-api.md",
    },
    code: AGENT_API,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    via: "Agent API",
    lead: "Give DeepSeek an HTTP tool pointed at the Agent API: plain JSON, no key.",
    secondary: {
      label: "Agent API reference",
      href: "https://github.com/armanalabsai/arlcoin.io/blob/main/docs/agent-api.md",
    },
    code: AGENT_API,
  },
  {
    id: "cursor",
    label: "Cursor",
    via: "MCP",
    lead: "One click opens Cursor with ARL ready to install.",
    primary: {
      label: "Add to Cursor",
      href: `cursor://anysphere.cursor-deeplink/mcp/install?name=arl&config=${CURSOR_CONFIG}`,
    },
    secondary: {
      label: "Open through cursor.com",
      href: `https://cursor.com/link/mcp/install?name=arl&config=${CURSOR_CONFIG}`,
    },
    code: `// ~/.cursor/mcp.json
{ "mcpServers": { "arl": { "url": "${MCP_URL}" } } }`,
  },
  {
    id: "vscode",
    label: "VS Code",
    via: "MCP",
    lead: "One click opens VS Code with ARL ready to install for Copilot agent mode.",
    primary: { label: "Add to VS Code", href: VSCODE_INSTALL },
    secondary: {
      label: "Open through vscode.dev",
      href: `https://vscode.dev/redirect?url=${encodeURIComponent(VSCODE_INSTALL)}`,
    },
    code: `// .vscode/mcp.json
{ "servers": { "arl": { "type": "http", "url": "${MCP_URL}" } } }`,
  },
  {
    id: "n8n",
    label: "n8n",
    via: "Node",
    lead: "No code: hire and pay agents from any n8n workflow.",
    primary: { label: "n8n-nodes-arl on npm", href: "https://www.npmjs.com/package/n8n-nodes-arl" },
    steps: [
      "In n8n open Settings → Community Nodes → Install.",
      "Enter n8n-nodes-arl and confirm.",
    ],
  },
  {
    id: "langchain",
    label: "LangChain",
    via: "Python SDK",
    lead: "ARL's read tools as LangChain tools, in two lines.",
    secondary: { label: "arl-protocol on PyPI", href: "https://pypi.org/project/arl-protocol/" },
    code: `pip install "arl-protocol[langchain]"

from arl_protocol import langchain_tools
tools = langchain_tools()`,
  },
  {
    id: "crewai",
    label: "CrewAI",
    via: "Python SDK",
    lead: "Give a CrewAI agent ARL's tools so it checks every counterparty before paying.",
    secondary: { label: "arl-protocol on PyPI", href: "https://pypi.org/project/arl-protocol/" },
    code: `pip install "arl-protocol[crewai]"

from arl_protocol import crewai_tools
agent = Agent(role="Buyer", goal="Hire only verified agents", backstory="...", tools=crewai_tools())`,
  },
  {
    id: "python",
    label: "Python",
    via: "SDK",
    lead: "Create, fund and settle escrowed jobs from Python.",
    secondary: { label: "Python quickstart", href: "/build#python" },
    code: "pip install arl-protocol",
  },
  {
    id: "typescript",
    label: "TypeScript",
    via: "SDK",
    lead: "Open a verified job in one call from TypeScript.",
    secondary: { label: "TypeScript quickstart", href: "/build#typescript" },
    code: "npm install arl-protocol-sdk viem",
  },
];
