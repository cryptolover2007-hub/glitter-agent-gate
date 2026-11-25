// Web page summary and field extraction for agents.
// Uses the same fetch path as web-markdown: robots.txt honored (also on cross-site redirects), every redirect re-checked
// for private/local addresses, size-capped. No email/phone harvesting. Summaries are extractive (Readability main
// content + sentence ranking) unless a Workers AI binding named AI is configured, which is capped atomically per day.
import { parseHTML } from "linkedom";
import type { Env } from "../types";
import { HttpError, json } from "../util";
import { fetchPage, htmlToMarkdown } from "./web-markdown";

export function validateWebAi(req: Request, subpath: string) {
  const q = new URL(req.url).searchParams;
  if (subpath !== "/summary" && subpath !== "/extract") throw new HttpError(404, "unknown route; use /summary or /extract");
  const u = q.get("url"); if (!u || !/^https?:\/\//i.test(u)) throw new HttpError(400, "missing or invalid ?url= (must be http/https)");
  if (subpath === "/extract") { const f = (q.get("fields") ?? "").split(",").map((x) => x.trim()).filter(Boolean); if (!f.length) throw new HttpError(400, "missing ?fields= (comma-separated, e.g. title,price,author)"); if (f.length > 15) throw new HttpError(400, "at most 15 fields"); }
  const len = q.get("length"); if (len && !["short", "medium", "long"].includes(len)) throw new HttpError(400, "length must be short, medium or long");
}

/** Atomic daily cap: one UPSERT that only increments below the cap. Returns false when today's budget is used up. */
async function takeAiBudget(env: Env): Promise<boolean> {
  const cap = Number(env.AI_DAILY_CAP ?? 250); const k = "ai:" + new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("INSERT INTO gate_kv (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 WHERE v < ? RETURNING v").bind(k, cap).first<{ v: number }>().catch(() => null);
  return !!row;
}
async function ai(env: Env, system: string, user: string, maxTokens: number): Promise<string | null> {
  const AI = env.AI; if (!AI) return null;
  if (!(await takeAiBudget(env))) return null;
  try { const r: any = await AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.2 }); return (r?.response ?? null) as string | null; } catch { return null; }
}

function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")                       // code blocks
    .replace(/^\s*\|.*\|\s*$/gm, "")                        // tables
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")                 // images
    .replace(/\((?:https?:\/\/|\/)[^)\s]*(?:\s+"[^"]*")?\)/g, "") // link targets
    .replace(/\\([\[\]()*_#`>-])/g, "$1")                   // markdown escapes
    .replace(/\[\d+\]|\[citation needed\]|\[edit\]/gi, "")  // citation markers
    .replace(/\[([^\]]*)\]/g, "$1")
    .replace(/\b(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?/gi, (u) => (/^[A-Z][a-z]+\.[A-Z]/.test(u) ? u : "")) // bare URLs / domains
    .replace(/^#+\s*/gm, "").replace(/[*_`>|]/g, "")
    .split("\n").filter((l) => /[.!?]["')\]]?\s*$/.test(l.trim()) || l.trim().length >= 80).join("\n") // drop infobox / nav fragments
    .replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
}
function rankSentences(text: string, n: number) {
  const sents = (text.replace(/\n+/g, " ").match(/[^.!?]{40,400}[.!?]/g) ?? []).map((s) => s.trim()).filter((s) => /^["'(\[]?[A-Z0-9]/.test(s));
  if (!sents.length) return text.slice(0, 600);
  const freq: Record<string, number> = {}; for (const w of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) freq[w] = (freq[w] ?? 0) + 1;
  return sents.map((s, i) => ({ s, i, v: (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).reduce((a, w) => a + (freq[w] ?? 0), 0) / Math.sqrt(s.length) + (i < 3 ? 2 : 0) }))
    .sort((a, b) => b.v - a.v).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s).join(" ");
}
function pageMeta(html: string) {
  const { document } = parseHTML(html);
  const m = (sel: string) => ((document.querySelector(sel) as any)?.getAttribute("content") || null) as string | null;
  const ld: any[] = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]') as any) { try { const j = JSON.parse(s.textContent ?? ""); ld.push(...(Array.isArray(j) ? j : j["@graph"] ?? [j])); } catch { /* ignore */ } }
  return { description: m('meta[name="description"]') ?? m('meta[property="og:description"]'), ogTitle: m('meta[property="og:title"]'), siteName: m('meta[property="og:site_name"]'), image: m('meta[property="og:image"]'),
    published: m('meta[property="article:published_time"]') ?? m('meta[name="date"]'), author: m('meta[name="author"]'), price: m('meta[property="product:price:amount"]') ?? m('meta[property="og:price:amount"]'), currency: m('meta[property="product:price:currency"]'), lang: (document.documentElement as any)?.getAttribute?.("lang") ?? null, ld };
}
function ldValue(ld: any[], f: string): unknown {
  const key = f.toLowerCase().replace(/\s+/g, "");
  for (const o of ld) {
    if (!o || typeof o !== "object") continue;
    if (/price/.test(key)) { const off = Array.isArray(o.offers) ? o.offers[0] : o.offers; if (off?.price != null) return `${off.price}${off.priceCurrency ? " " + off.priceCurrency : ""}`; }
    if (/author/.test(key) && o.author) return Array.isArray(o.author) ? o.author.map((a: any) => a?.name ?? a).join(", ") : o.author?.name ?? o.author;
    if (/date|published/.test(key) && (o.datePublished || o.dateCreated)) return o.datePublished ?? o.dateCreated;
    if (/rating/.test(key) && o.aggregateRating) return o.aggregateRating.ratingValue;
    for (const k of Object.keys(o)) if (k.toLowerCase() === key && (typeof o[k] === "string" || typeof o[k] === "number")) return o[k];
  }
  return undefined;
}

export async function webAiHandler(req: Request, env: Env, subpath: string): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const page = await fetchPage(q.get("url")!, env);
  const md = page.contentType.includes("text/plain") ? { title: "", markdown: page.html, wordCount: page.html.split(/\s+/).length, byline: null, excerpt: null, siteName: null } : htmlToMarkdown(page.html, page.finalUrl, "readable");
  const text = plainText(md.markdown);
  if (text.length < 80) throw new HttpError(422, "the page has no readable text (not charged)");
  const meta = page.contentType.includes("text/plain") ? null : pageMeta(page.html);
  if (subpath === "/summary") {
    const len = q.get("length") ?? "short", n = len === "long" ? 8 : len === "medium" ? 5 : 3;
    const s = await ai(env, `Summarize the web page for an AI agent in ${n} concise sentences using only facts from the page. Then list up to 5 key facts as "- " bullets.`, `Title: ${md.title}\n\n${text.slice(0, 12000)}`, 450);
    return json({ url: q.get("url"), finalUrl: page.finalUrl, title: md.title || meta?.ogTitle || null, description: meta?.description ?? md.excerpt ?? null, byline: md.byline, published: meta?.published ?? null,
      summary: s?.trim() || rankSentences(text, n), method: s ? "ai" : "extractive", words: md.wordCount, language: meta?.lang ?? null });
  }
  const fields = q.get("fields")!.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 15);
  let data: Record<string, unknown> | null = null, method = "metadata";
  const r = await ai(env, "Extract the requested fields from the web page. Reply with ONLY a JSON object whose keys are exactly the requested field names; use null when a value is not on the page. Never invent values.", `Fields: ${fields.join(", ")}\nTitle: ${md.title}\n\n${text.slice(0, 12000)}`, 500);
  if (r) { try { data = JSON.parse(r.slice(r.indexOf("{"), r.lastIndexOf("}") + 1)); method = "ai"; } catch { data = null; } }
  if (!data) data = Object.fromEntries(fields.map((f) => {
    const k = f.toLowerCase(); const fromLd = meta ? ldValue(meta.ld, f) : undefined;
    const v = fromLd !== undefined ? fromLd : /^(title|name|headline)$/.test(k) ? (md.title || meta?.ogTitle) : /desc|summary/.test(k) ? (meta?.description ?? md.excerpt) : /author|byline/.test(k) ? (md.byline ?? meta?.author) : /date|published/.test(k) ? meta?.published : /price/.test(k) ? (meta?.price ? `${meta.price}${meta.currency ? " " + meta.currency : ""}` : null) : /site|publisher/.test(k) ? (meta?.siteName ?? md.siteName) : /image/.test(k) ? meta?.image : /lang/.test(k) ? meta?.lang : null;
    return [f, v ?? null];
  }));
  if (method === "metadata" && Object.values(data).every((v) => v == null)) throw new HttpError(422, "none of the requested fields were found on the page (not charged)");
  return json({ url: q.get("url"), finalUrl: page.finalUrl, title: md.title || null, fields: data, method });
}
