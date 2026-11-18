// Web page -> clean Markdown. Plain fetch + Readability. Honors robots.txt.
// Deliberately does NOT bypass captchas, logins, paywalls or anti-bot protection.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { Env } from "../types";
import { assertPublicHttpUrl, HttpError, json, readCapped } from "../util";

export const USER_AGENT = "GlitterAgentGateBot/0.1 (+https://agents.glitterchainscout.trade/llms.txt; respects robots.txt)";
const MAX_BYTES = 3 * 1024 * 1024;

async function robotsAllowed(u: URL): Promise<boolean> {
  try {
    const r = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return true;
    const text = (await r.text()).slice(0, 200_000);
    let applies = false;
    const disallow: string[] = [];
    const allow: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      const key = k.toLowerCase();
      if (key === "user-agent") applies = v === "*" || USER_AGENT.toLowerCase().startsWith(v.toLowerCase());
      else if (applies && key === "disallow" && v) disallow.push(v);
      else if (applies && key === "allow" && v) allow.push(v);
    }
    const p = u.pathname + u.search;
    const longest = (arr: string[]) => Math.max(-1, ...arr.filter((r) => p.startsWith(r.replace(/\*.*$/, ""))).map((r) => r.length));
    return longest(allow) >= longest(disallow);
  } catch {
    return true;
  }
}

export async function fetchPage(rawUrl: string, env: Env): Promise<{ finalUrl: string; html: string; contentType: string }> {
  let u = assertPublicHttpUrl(rawUrl, false);
  if (!(await robotsAllowed(u))) throw new HttpError(403, "robots.txt disallows fetching this URL");
  for (let i = 0; i < 5; i++) {
    const r = await fetch(u.toString(), {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      u = assertPublicHttpUrl(new URL(r.headers.get("location")!, u).toString(), false);
      continue;
    }
    if (!r.ok) throw new HttpError(502, `upstream page returned HTTP ${r.status}`);
    const ct = r.headers.get("content-type") ?? "";
    if (!/text\/html|xhtml|text\/plain/.test(ct)) throw new HttpError(415, `unsupported content-type: ${ct || "unknown"}`);
    const bytes = await readCapped(r.body, MAX_BYTES);
    return { finalUrl: u.toString(), html: new TextDecoder().decode(bytes), contentType: ct };
  }
  throw new HttpError(508, "too many redirects");
}

export function htmlToMarkdown(html: string, baseUrl: string, mode: "readable" | "full" = "readable") {
  const { document } = parseHTML(html);
  // Make relative links absolute.
  for (const el of document.querySelectorAll("a[href], img[src]") as any) {
    const attr = el.hasAttribute("href") ? "href" : "src";
    try { el.setAttribute(attr, new URL(el.getAttribute(attr), baseUrl).toString()); } catch { /* ignore */ }
  }
  for (const el of document.querySelectorAll("script, style, noscript, iframe, svg, template") as any) el.remove();
  const title = (document.querySelector("title")?.textContent ?? "").trim();
  let contentRoot: any = document.body ?? document.documentElement;
  let byline: string | null = null;
  let excerpt: string | null = null;
  let siteName: string | null = null;
  if (mode === "readable") {
    try {
      const article = new Readability(document.cloneNode(true) as any, { charThreshold: 200 }).parse();
      if (article?.content) {
        contentRoot = parseHTML(`<html><body>${article.content}</body></html>`).document.body;
        byline = article.byline ?? null;
        excerpt = article.excerpt ?? null;
        siteName = article.siteName ?? null;
      }
    } catch { /* fall back to full body */ }
  }
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  const markdown = td.turndown(contentRoot).replace(/\n{3,}/g, "\n\n").trim();
  return { title, byline, excerpt, siteName, markdown, wordCount: markdown.split(/\s+/).filter(Boolean).length };
}

export async function webMarkdownHandler(req: Request, env: Env): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const target = q.get("url");
  if (!target) throw new HttpError(400, "missing ?url=");
  const mode = q.get("mode") === "full" ? "full" : "readable";
  const page = await fetchPage(target, env);
  const out = page.contentType.includes("text/plain")
    ? { title: "", byline: null, excerpt: null, siteName: null, markdown: page.html, wordCount: page.html.split(/\s+/).length }
    : htmlToMarkdown(page.html, page.finalUrl, mode);
  return json({ url: target, finalUrl: page.finalUrl, mode, fetchedAt: new Date().toISOString(), ...out });
}
