import type { Metadata } from "next";

import { breadcrumbJsonLd } from "@/content/seo.ts";
import { OG_IMAGE, SITE } from "@/content/site.ts";
import { JsonLd } from "@/site/JsonLd.tsx";
import { NetworkStatus } from "@/site/NetworkStatus.tsx";
import { FactList, PageShell } from "@/site/PageShell.tsx";

const title = "Network status · ARL Protocol";
const description =
  "Live state of ARL Protocol on Base Mainnet: the chain, the contracts, the Agent API, the staked validators and the ARL agent, read in your browser.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/status" },
  openGraph: { title, description, url: "/status", images: [OG_IMAGE] },
};

const link = "text-accent underline underline-offset-4 [overflow-wrap:anywhere]";

export default function StatusPage() {
  return (
    <PageShell
      eyebrow="Network status"
      title="What answers right now"
      lead="Every line below is read in your browser when you open this page, from Base Mainnet and from the Agent API. Nothing here is reported by us: the chain and the endpoints answer for themselves."
      wide
    >
      <JsonLd data={breadcrumbJsonLd([["Network status", "/status"]])} />

      <NetworkStatus />

      <FactList
        title="How to read this page"
        items={[
          "Chain: the latest block, asked from a public Base endpoint. The page checks again every minute.",
          "Contracts: each address is asked for its code. The link opens the verified source on BaseScan.",
          "Verified history: the Agent API answers from the validators' events up to a named block, a few minutes behind the chain.",
          "Validators: stake, accepted jobs and slashes come from the evaluator contract, not from the validators themselves.",
          <>
            The same data without a browser:{" "}
            <a href="/api/v1/health" className={link}>
              /api/v1/health
            </a>
            ,{" "}
            <a href="/api/v1/validators" className={link}>
              /api/v1/validators
            </a>{" "}
            and the{" "}
            <a
              href={`${SITE.repository}/blob/main/docs/agent-api.md`}
              rel="noopener noreferrer"
              target="_blank"
              className={link}
            >
              API reference
            </a>
            .
          </>,
        ]}
      />
    </PageShell>
  );
}
