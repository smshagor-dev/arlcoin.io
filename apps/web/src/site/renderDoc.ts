import { readFileSync } from "node:fs";
import path from "node:path";

import { Marked, type Tokens } from "marked";

import { DOCS, docPath, type DocEntry } from "../content/docs.ts";

// Renders a published repository file to HTML at build time. The files are the project's own,
// so the HTML is trusted. Links to other published files point at their /docs page, links to
// files that are not published lose their link (the text stays), and outside links open in a
// new tab.

const repoRoot = path.join(process.cwd(), "..", "..");

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function resolveLink(from: DocEntry, href: string): string | null {
  if (/^(https?:|mailto:)/.test(href)) return href;
  if (href.startsWith("#")) return href;
  const [file, anchor] = href.split("#");
  if (!file) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from.source), file));
  const doc = DOCS.find((d) => d.source === target);
  return doc ? docPath(doc.slug) + (anchor ? `#${anchor}` : "") : null;
}

/** The text of a heading as a reader sees it, taken from its tokens (never from its HTML). */
function headingText(tokens: readonly Tokens.Generic[]): string {
  return tokens
    .map((t) => {
      const inner = (t as { tokens?: Tokens.Generic[] }).tokens;
      if (inner && inner.length > 0) return headingText(inner);
      return typeof t.text === "string" ? t.text : "";
    })
    .join("");
}

/**
 * The anchor of a heading, as GitHub makes it: lower case, everything but letters, digits,
 * spaces, hyphens and underscores dropped, spaces to hyphens.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Gives a repeated heading `-1`, `-2`… like GitHub, so every anchor on a page is unique. */
function anchorCounter() {
  const seen = new Map<string, number>();
  return {
    next(text: string): string {
      const slug = headingSlug(text);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      return count === 0 ? slug : `${slug}-${String(count)}`;
    },
  };
}

export function renderDoc(doc: DocEntry): string {
  const anchors = anchorCounter();
  const raw = readFileSync(path.join(/* turbopackIgnore: true */ repoRoot, doc.source), "utf8");
  if (!doc.source.endsWith(".md")) {
    const lang = path.extname(doc.source).slice(1);
    return `<pre class="doc-code"><code data-lang="${escape(lang)}">${escape(raw)}</code></pre>`;
  }
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      link(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        const href = resolveLink(doc, token.href);
        if (!href) return text;
        const external = /^https?:/.test(href);
        return `<a href="${escape(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
      },
      image(token: Tokens.Image) {
        return escape(token.text);
      },
      // Headings carry the anchor GitHub gives them, so a link to a section of a document
      // (`tokenomics.md#custody`) lands on that section here too.
      heading(
        this: { parser: { parseInline: (t: Tokens.Generic[]) => string } },
        token: Tokens.Heading,
      ) {
        const html = this.parser.parseInline(token.tokens);
        const id = anchors.next(headingText(token.tokens));
        const tag = `h${String(token.depth)}`;
        return `<${tag} id="${escape(id)}">${html}</${tag}>
`;
      },
    },
  });
  // The first heading is shown by the page itself.
  return marked.parse(raw.replace(/^# .*\n/, ""), { async: false });
}
