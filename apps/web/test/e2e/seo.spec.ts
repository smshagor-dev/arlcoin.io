import { expect, test } from "@playwright/test";

// Search basics on every page the sitemap lists, read from the server-rendered HTML: a title and
// a description of a length search engines show in full, both unique across the site, a canonical
// link to the page itself, Open Graph and Twitter tags, one h1, alt text on every image,
// structured data, no noindex. scripts/seo-audit.py runs the same checks on the live site.

const TITLE = { min: 25, max: 60 };
const DESCRIPTION = { min: 70, max: 160 };

// One pass over the entities, so that an escaped ampersand is never decoded twice.
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};
const decode = (s: string) => s.replace(/&(?:amp|quot|#x27|#39|lt|gt);/g, (e) => ENTITIES[e] ?? e);

const metaContent = (head: string, attr: "name" | "property", key: string) => {
  const tag = [...head.matchAll(/<meta\b[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes(`${attr}="${key}"`));
  const content = tag?.match(/content="([^"]*)"/)?.[1];
  return content === undefined ? undefined : decode(content);
};

test.skip(({ isMobile }) => isMobile, "the HTML is the same on every device");

test("every page in the sitemap has the search basics", async ({ request }) => {
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
  expect(urls.length).toBeGreaterThan(50);

  const problems: string[] = [];
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();

  for (const url of urls) {
    const path = new URL(url).pathname;
    const res = await request.get(path);
    if (res.status() !== 200) {
      problems.push(`${path}: status ${String(res.status())}`);
      continue;
    }
    const html = await res.text();
    const head = html.split("</head>")[0] ?? "";
    const say = (what: string) => problems.push(`${path}: ${what}`);

    const title = decode(head.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
    if (title.length < TITLE.min || title.length > TITLE.max)
      say(`title of ${String(title.length)} characters: ${title}`);
    const seenTitle = titles.get(title);
    if (seenTitle) say(`same title as ${seenTitle}`);
    titles.set(title, path);

    const description = metaContent(head, "name", "description") ?? "";
    if (description.length < DESCRIPTION.min || description.length > DESCRIPTION.max)
      say(`description of ${String(description.length)} characters`);
    const seenDescription = descriptions.get(description);
    if (seenDescription) say(`same description as ${seenDescription}`);
    descriptions.set(description, path);

    const canonical = head.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
    if (!canonical || canonical.replace(/\/$/, "") !== url.replace(/\/$/, ""))
      say(`canonical ${String(canonical)}`);

    for (const key of ["og:title", "og:description", "og:image", "og:url"])
      if (!metaContent(head, "property", key)) say(`no ${key}`);
    if (!metaContent(head, "name", "twitter:card")) say("no twitter:card");
    if ((metaContent(head, "name", "robots") ?? "").includes("noindex")) say("noindex");

    const h1 = html.match(/<h1[\s>]/g)?.length ?? 0;
    if (h1 !== 1) say(`${String(h1)} h1 headings`);
    for (const img of html.match(/<img\b[^>]*>/g) ?? [])
      if (!/\salt="/.test(img)) say(`image without alt: ${img.slice(0, 80)}`);
    if (!html.includes('type="application/ld+json"')) say("no structured data");
  }

  expect(problems).toEqual([]);
});
