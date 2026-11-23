import type { Metadata } from "next";
import Link from "next/link";

import { CONNECT, MCP_URL, type ConnectLink } from "@/content/connect.ts";
import { breadcrumbJsonLd } from "@/content/seo.ts";
import { OG_IMAGE } from "@/content/site.ts";
import { JsonLd } from "@/site/JsonLd.tsx";
import { PageShell } from "@/site/PageShell.tsx";

const title = "Connect your AI tool to ARL · ARL Protocol";
const description =
  "Add ARL to Claude, ChatGPT, Gemini, Cursor, VS Code, n8n, LangChain or CrewAI in one step: a remote MCP server at arlcoin.io/mcp, no install and no key.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/connect" },
  openGraph: { title, description, url: "/connect", images: [OG_IMAGE] },
};

const link = "text-accent underline underline-offset-4";

function isExternal(href: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

function Button({ item, primary }: { item: ConnectLink; primary: boolean }) {
  const className = primary
    ? "inline-flex items-center rounded-full bg-accent px-5 py-2.5 text-[15px] font-semibold text-[#0a1226] shadow-[0_0_14px_rgb(217_183_122/0.45)] hover:brightness-110"
    : "inline-flex items-center rounded-full border border-line px-5 py-2.5 text-[15px] font-semibold text-heading hover:border-accent";
  // A page of this site goes through the router; an app link (cursor:, vscode:) opens the app.
  if (!isExternal(item.href) && !item.href.startsWith("/.well-known")) {
    return (
      <Link href={item.href} prefetch={false} className={className}>
        {item.label}
      </Link>
    );
  }
  const web = item.href.startsWith("http");
  return (
    <a
      href={item.href}
      {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={className}
    >
      {item.label}
    </a>
  );
}

export default function ConnectPage() {
  return (
    <PageShell
      eyebrow="Connect"
      title="Connect your AI tool to ARL"
      lead={`Pick your tool and press its button. Most tools reach ARL through one remote MCP server at ${MCP_URL}: nothing to install, no account and no key. ARL never holds a key; anything that moves money comes back as an unsigned transaction for your own wallet.`}
      wide
    >
      <JsonLd data={breadcrumbJsonLd([["Connect your AI tool", "/connect"]])} />

      <nav aria-label="Tools" className="flex flex-wrap gap-2">
        {CONNECT.map((c) => (
          <a
            key={c.id}
            href={`#${c.id}`}
            className="rounded-full border border-line px-3 py-1 text-[14px] text-fg-muted hover:border-accent hover:text-heading"
          >
            {c.label}
          </a>
        ))}
      </nav>

      {CONNECT.map((c) => (
        <section key={c.id} id={c.id} className="glass scroll-mt-24 rounded-[22px] p-6">
          <h2 className="text-[24px] font-bold text-heading">
            {c.label}{" "}
            <span className="font-mono text-[13px] font-normal tracking-[0.04em] text-fg-subtle">
              {c.via}
            </span>
          </h2>
          <p className="mt-2 text-[16px] leading-[1.6]">{c.lead}</p>
          {(c.primary ?? c.secondary) && (
            <div className="mt-4 flex flex-wrap gap-3">
              {c.primary && <Button item={c.primary} primary />}
              {c.secondary && <Button item={c.secondary} primary={false} />}
            </div>
          )}
          {c.steps && (
            <ol className="mt-4 list-decimal pl-5 text-[15px] leading-[1.6] text-fg-muted">
              {c.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {c.code && (
            <pre className="glass mt-4 overflow-x-auto rounded-[14px] p-4 text-left font-mono text-[12.5px] leading-[1.55] text-fg">
              <code>{c.code}</code>
            </pre>
          )}
        </section>
      ))}

      <p className="text-[15px] text-fg-muted">
        Every path, with full examples, is on{" "}
        <Link href="/build" prefetch={false} className={link}>
          Build with ARL
        </Link>
        .
      </p>
    </PageShell>
  );
}
