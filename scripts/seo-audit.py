"""SEO audit of arlcoin.io from its sitemap.

Checks every page the sitemap lists: status, title and description length, duplicates, canonical,
Open Graph and Twitter tags, noindex, one h1, image alt text, structured data, language, and pages
no other page links to. Prints a JSON summary of the findings.

    python scripts/seo-audit.py
"""
import collections
import concurrent.futures
import html as htmlmod
import json
import re
import sys
import urllib.error
import urllib.request

BASE = "https://arlcoin.io"
UA = {"User-Agent": "Mozilla/5.0 (seo check)"}


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.geturl(), r.read().decode("utf8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, url, "", {}
    except Exception as e:  # noqa: BLE001
        return 0, url, str(e)[:80], {}


def meta(body, attr, name):
    m = re.search(
        r'<meta[^>]+%s="%s"[^>]*content="([^"]*)"' % (attr, re.escape(name)), body
    ) or re.search(r'<meta[^>]+content="([^"]*)"[^>]*%s="%s"' % (attr, re.escape(name)), body)
    return htmlmod.unescape(m.group(1)) if m else None


status, _, sitemap, _ = fetch(BASE + "/sitemap.xml")
pages = re.findall(r"<loc>([^<]+)</loc>", sitemap)
robots = fetch(BASE + "/robots.txt")[2]

rows = {}
with concurrent.futures.ThreadPoolExecutor(8) as pool:
    for url, (code, final, body, headers) in zip(pages, pool.map(fetch, pages)):
        rows[url] = (code, final, body, headers)

issues = collections.defaultdict(list)
titles = collections.defaultdict(list)
descs = collections.defaultdict(list)
inbound = collections.Counter()
schema_types = collections.Counter()

for url, (code, final, body, headers) in rows.items():
    path = url.replace(BASE, "") or "/"
    if code != 200:
        issues["status"].append(f"{path} {code}")
        continue
    head = body.split("</head>")[0]
    t = re.search(r"<title>(.*?)</title>", head, re.S)
    title = htmlmod.unescape(t.group(1).strip()) if t else None
    if not title:
        issues["title missing"].append(path)
    else:
        titles[title].append(path)
        if len(title) > 65:
            issues["title > 65 chars"].append(f"{path} ({len(title)}) {title}")
        if len(title) < 25:
            issues["title < 25 chars"].append(f"{path} ({len(title)}) {title}")
    d = meta(head, "name", "description")
    if not d:
        issues["description missing"].append(path)
    else:
        descs[d].append(path)
        if len(d) > 165:
            issues["description > 165 chars"].append(f"{path} ({len(d)})")
        if len(d) < 70:
            issues["description < 70 chars"].append(f"{path} ({len(d)}) {d}")
    c = re.search(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', head)
    if not c:
        issues["canonical missing"].append(path)
    else:
        can = c.group(1).rstrip("/")
        if can != url.rstrip("/"):
            issues["canonical differs from sitemap URL"].append(f"{path} -> {c.group(1)}")
    for prop in ("og:title", "og:description", "og:image", "og:url"):
        if not meta(head, "property", prop):
            issues[f"{prop} missing"].append(path)
    if not meta(head, "name", "twitter:card"):
        issues["twitter:card missing"].append(path)
    robots_meta = meta(head, "name", "robots") or ""
    if "noindex" in robots_meta:
        issues["noindex on a sitemap page"].append(path)
    h1 = re.findall(r"<h1[\s>]", body)
    if len(h1) != 1:
        issues[f"h1 count != 1"].append(f"{path} ({len(h1)})")
    for img in re.findall(r"<img\b[^>]*>", body):
        if not re.search(r'\salt="', img):
            issues["img without alt"].append(f"{path} {img[:80]}")
    ld = re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', body, re.S)
    if not ld:
        issues["no JSON-LD"].append(path)
    for block in ld:
        for ty in re.findall(r'"@type":"([^"]+)"', block):
            schema_types[ty] += 1
    lang = re.search(r'<html[^>]+lang="([^"]+)"', body)
    if not lang:
        issues["html lang missing"].append(path)
    for href in set(re.findall(r'<a\s[^>]*?href="(/[^"#?]*)', body)):
        inbound[BASE + (href if href.endswith("/") or "." in href.split("/")[-1] else href + "/")] += 1
    if "x-robots-tag" in {k.lower() for k in headers} and "noindex" in str(headers).lower():
        issues["X-Robots-Tag noindex"].append(path)

for t, ps in titles.items():
    if len(ps) > 1:
        issues["duplicate title"].append(f"{t} :: {ps}")
for d, ps in descs.items():
    if len(ps) > 1:
        issues["duplicate description"].append(f"{d[:60]}... :: {ps}")
for url in rows:
    key = url if url.endswith("/") else url + "/"
    if inbound[key] == 0 and url.rstrip("/") != BASE:
        issues["no internal link from other sitemap pages"].append(url.replace(BASE, ""))

print(json.dumps({
    "pages": len(pages),
    "robots": robots[:400],
    "schema_types": schema_types.most_common(),
    "issues": {k: (len(v), v[:12]) for k, v in sorted(issues.items())},
}, indent=1, ensure_ascii=False))
