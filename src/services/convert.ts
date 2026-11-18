// File conversion: PDF / CSV / XLSX / HTML -> JSON or text. Pure parsing, no code execution.
import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";
import type { Env } from "../types";
import { assertPublicHttpUrl, HttpError, json, readCapped } from "../util";
import { htmlToMarkdown, USER_AGENT } from "./web-markdown";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;

export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", i = 0, q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { q = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      row.push(field); field = ""; rows.push(row); row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++; if (rows.length > MAX_ROWS) throw new HttpError(413, `more than ${MAX_ROWS} rows`); continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function detectFormat(ct: string, explicit: string | null, bytes: Uint8Array): string {
  if (explicit) return explicit.toLowerCase();
  if (ct.includes("pdf") || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return "pdf";
  if (ct.includes("spreadsheetml") || ct.includes("ms-excel")) return "xlsx";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "xlsx"; // zip container
  if (ct.includes("csv")) return "csv";
  if (ct.includes("html")) return "html";
  if (ct.includes("tab-separated")) return "tsv";
  return "";
}

export function validateConvert(req: Request) {
  if (req.method !== "POST") throw new HttpError(405, "POST the file bytes as the request body");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) throw new HttpError(413, `file exceeds ${MAX_BYTES} bytes`);
  const f = new URL(req.url).searchParams.get("format");
  if (f && !["pdf", "csv", "tsv", "xlsx", "xls", "html"].includes(f)) throw new HttpError(400, "format must be pdf|csv|tsv|xlsx|xls|html");
}

export async function convertHandler(req: Request, env: Env, bodyBytes?: Uint8Array): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const to = (q.get("to") ?? "json").toLowerCase();
  let bytes = bodyBytes ?? (await readCapped(req.body, MAX_BYTES));
  if (!bytes.length) throw new HttpError(400, "empty body");
  let ct = req.headers.get("content-type") ?? "";
  let explicit = q.get("format");
  // JSON mode (agent/Bazaar friendly): {"url": "https://.../file.pdf"} or {"content_base64": "...", "format": "csv"}
  if (ct.includes("application/json")) {
    let body: any;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, "invalid JSON body"); }
    if (body.format) explicit = String(body.format);
    if (typeof body.content_base64 === "string") {
      const bin = atob(body.content_base64);
      if (bin.length > MAX_BYTES) throw new HttpError(413, "file too large");
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      ct = "";
    } else if (typeof body.url === "string") {
      const u = assertPublicHttpUrl(body.url);
      const r = await fetch(u.toString(), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new HttpError(502, `file URL returned HTTP ${r.status}`);
      ct = r.headers.get("content-type") ?? "";
      bytes = await readCapped(r.body, MAX_BYTES);
    } else throw new HttpError(400, 'JSON body needs "url" or "content_base64"');
  }
  const format = detectFormat(ct, explicit, bytes);
  const base = { format, bytes: bytes.length, convertedAt: new Date().toISOString() };

  if (format === "csv" || format === "tsv") {
    const rows = parseCsv(new TextDecoder().decode(bytes), format === "tsv" ? "\t" : (q.get("delimiter") ?? ",").slice(0, 1));
    const header = q.get("header") !== "false";
    const columns = header ? rows[0] ?? [] : (rows[0] ?? []).map((_, i) => `col${i + 1}`);
    const data = (header ? rows.slice(1) : rows).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""])));
    if (to === "text") return new Response(rows.map((r) => r.join("\t")).join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ ...base, columns, rowCount: data.length, rows: data });
  }
  if (format === "xlsx" || format === "xls") {
    const wb = XLSX.read(bytes, { type: "array", cellDates: true, dense: true });
    const sheets = wb.SheetNames.slice(0, 20).map((name) => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "", raw: false }).slice(0, MAX_ROWS);
      return { name, rowCount: rows.length, rows };
    });
    if (to === "text") return new Response(wb.SheetNames.map((n) => `# ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ ...base, sheetCount: wb.SheetNames.length, sheets });
  }
  if (format === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = (text as string[]).slice(0, 500);
    if (to === "text") return new Response(pages.join("\n\n\f\n\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return json({ ...base, totalPages, pages: pages.map((t, i) => ({ page: i + 1, text: t })) });
  }
  if (format === "html") {
    const out = htmlToMarkdown(new TextDecoder().decode(bytes), q.get("base_url") ?? "https://example.invalid/", q.get("mode") === "full" ? "full" : "readable");
    if (to === "text") return new Response(out.markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    return json({ ...base, ...out });
  }
  throw new HttpError(415, "could not detect format; pass ?format=pdf|csv|tsv|xlsx|html or a proper Content-Type");
}
