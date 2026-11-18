// Safe deterministic JSON utilities. Pure data transforms: no eval, no regex from users, no code execution.
import { HttpError, json, readCapped } from "../util";

const MAX = 512 * 1024;
type Op = { op: string; [k: string]: unknown };

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) && Array.isArray(o) ? Number(k) : k]), obj);
}
function flatten(obj: any, prefix = "", out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (depth > 32) throw new HttpError(400, "nesting too deep");
  if (obj !== null && typeof obj === "object") {
    const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v]) : Object.entries(obj);
    if (!entries.length) out[prefix] = obj;
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out[prefix] = obj;
  return out;
}
function toCsv(rows: any[]): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(flatten(r))))];
  const esc = (v: unknown) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => { const f = flatten(r); return cols.map((c) => esc(f[c])).join(","); })].join("\n");
}
function apply(data: any, op: Op): any {
  const arr = () => { if (!Array.isArray(data)) throw new HttpError(400, `${op.op} needs an array`); return data as any[]; };
  switch (op.op) {
    case "pick": { const paths = op.paths as string[]; const pick = (o: any) => Object.fromEntries(paths.map((p) => [p, getPath(o, p)])); return Array.isArray(data) ? data.map(pick) : pick(data); }
    case "get": return getPath(data, String(op.path));
    case "flatten": return Array.isArray(data) ? data.map((d) => flatten(d)) : flatten(data);
    case "filter_eq": return arr().filter((r) => getPath(r, String(op.path)) === op.value);
    case "sort_by": { const p = String(op.path); const dir = op.desc ? -1 : 1; return [...arr()].sort((a, b) => { const x = getPath(a, p), y = getPath(b, p); return x === y ? 0 : x > y ? dir : -dir; }); }
    case "dedupe": { const p = op.path ? String(op.path) : null; const seen = new Set<string>(); return arr().filter((r) => { const k = JSON.stringify(p ? getPath(r, p) : r); if (seen.has(k)) return false; seen.add(k); return true; }); }
    case "limit": return arr().slice(0, Math.max(0, Math.min(Number(op.n) || 0, 100000)));
    case "count": return Array.isArray(data) ? data.length : Object.keys(data ?? {}).length;
    case "keys": return Object.keys(data ?? {});
    case "to_csv": return toCsv(arr());
    default: throw new HttpError(400, `unknown op ${op.op}; allowed: pick,get,flatten,filter_eq,sort_by,dedupe,limit,count,keys,to_csv`);
  }
}
export function validateJsonTools(req: Request) {
  if (req.method !== "POST") throw new HttpError(405, 'POST {"data": <json>, "ops": [{"op":"pick","paths":["a.b"]}]}');
}
export async function jsonToolsHandler(req: Request, _env: unknown, bodyBytes?: Uint8Array): Promise<Response> {
  const bytes = bodyBytes ?? (await readCapped(req.body, MAX));
  let body: any;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, "body must be JSON"); }
  const ops: Op[] = Array.isArray(body?.ops) ? body.ops.slice(0, 20) : [];
  let data = body?.data;
  for (const op of ops) data = apply(data, op);
  return json({ ok: true, opsApplied: ops.map((o) => o.op), result: data });
}
