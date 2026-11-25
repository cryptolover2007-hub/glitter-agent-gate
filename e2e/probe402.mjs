// Probes every paid endpoint (unpaid) and checks the 402 shape per network. Usage: node probe402.mjs <base>
const B = process.argv[2] ?? "http://localhost:8788";
const eps = [["GET","/s/hello?name=t"],["GET","/s/web-markdown?url=https://example.com"],["GET","/s/xrpl-data/account?address=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"],["GET","/s/xrpl-data/token"],["GET","/s/xrpl-data/prices"],
  ["GET","/s/xrpl-token-safety?currency=RLUSD"],["GET","/s/xrpl-token-safety"],["POST","/s/convert"],["GET","/s/convert"],["POST","/s/json-tools"],["GET","/s/json-tools"]];
let fail = 0;
for (const [m, p] of eps) {
  const r = await fetch(B + p, { method: m, headers: m === "POST" ? { "content-type": "application/json" } : {}, body: m === "POST" ? JSON.stringify({ data: [1], ops: [{ op: "count" }] }) : undefined });
  const h = r.headers.get("payment-required");
  let pr = null; try { pr = JSON.parse(Buffer.from(h, "base64").toString()); } catch {}
  const nets = pr?.accepts?.map((a) => `${a.network.split(":")[0]}:${a.amount}`).join(" ") ?? "-";
  const ok = r.status === 402 && pr?.x402Version === 2 && pr.accepts.every((a) => a.scheme === "exact" && a.payTo && a.asset && a.extra?.invoiceId) && pr.accepts.some((a) => a.network === "eip155:8453");
  if (!ok) fail++;
  console.log(ok ? "ok  " : "FAIL", r.status, m, p, "|", nets, pr?.error?.startsWith("invalid_input") ? "| " + pr.error.slice(0, 70) : "");
}
for (const p of ["/robots.txt", "/", "/services", "/.well-known/x402", "/openapi.json", "/llms.txt", "/discovery/resources?limit=100"]) {
  const r = await fetch(B + p); const t = await r.text();
  console.log(r.status === 200 ? "ok  " : "FAIL", r.status, p, t.length, p === "/robots.txt" ? JSON.stringify(t.slice(0, 60)) : t.includes("xrpl-token-safety") ? "(has safety)" : "");
  if (r.status !== 200) fail++;
}
process.exit(fail ? 1 : 0);
