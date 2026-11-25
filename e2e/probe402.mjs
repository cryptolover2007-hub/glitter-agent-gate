// Probes every paid endpoint (unpaid) and checks the 402 shape per network. Usage: node probe402.mjs <base>
const B = process.argv[2] ?? "http://localhost:8788";
const eps = [["GET","/s/hello?name=t"],["GET","/s/web-markdown?url=https://example.com"],["GET","/s/xrpl-data/account?address=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"],["GET","/s/xrpl-data/token"],["GET","/s/xrpl-data/prices"],
  ["GET","/s/xrpl-token-safety?currency=RLUSD"],["GET","/s/xrpl-token-safety"],["POST","/s/convert"],["GET","/s/convert"],["POST","/s/json-tools"],["GET","/s/json-tools"],
  ["GET","/s/base-token-safety?address=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"],["GET","/s/base-token-safety"],["GET","/s/base-honeypot?address=0xFF0C532FDB8Cd566Ae169C1CB157ff2Bdc83E105"],
  ["GET","/s/base-data/balance?address=0xEd31466eF9Ff467436F829eFF222bD2c07803d7a"],["GET","/s/base-data/token?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],["GET","/s/base-data/block"],["GET","/s/base-data/tx?hash=0x" + "ab".repeat(32)],["GET","/s/base-data/transfers?token=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
  ["GET","/s/xrpl-more/nfts?address=rLULtFuV1agdSQdVmSd7AYx2cfEiN6noxY"],["GET","/s/xrpl-more/amm?asset2=RLUSD.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"],["GET","/s/xrpl-more/orderbook?quote=RLUSD.rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"],["GET","/s/xrpl-more/history?address=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"],
  ["GET","/s/xrpl-presend?destination=rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh&amount=25"],["GET","/s/xrpl-presend"],
  ["GET","/s/web-ai/summary?url=https://example.com"],["GET","/s/web-ai/extract?url=https://example.com&fields=title"]];
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
// v1 payment header with garbage must be rejected 400 (never charged); unknown sub-route 404; MCP lists tools and caps batches
{ const r = await fetch(B + "/s/hello", { headers: { "x-payment": "not-base64!" } }); const ok = r.status === 400; if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", r.status, "v1 garbage X-PAYMENT"); }
{ const r = await fetch(B + "/s/base-data/nope"); const ok = r.status === 404; if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", r.status, "unknown sub-route"); }
{ const r = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }); const j = await r.json(); const n = j.result?.tools?.length ?? 0; const ok = n >= 15; if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", r.status, "MCP tools/list", n); }
{ const r = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))) }); const ok = r.status === 400; if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", r.status, "MCP batch of 11 refused"); }
{ const r = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "xrpl_presend", arguments: { destination: "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh" } } }) }); const j = await r.json(); const ok = j.result?.isError && j.result?._meta?.["x402/error"]?.x402Version === 2; if (!ok) fail++; console.log(ok ? "ok  " : "FAIL", r.status, "MCP unpaid call returns x402 requirements"); }
for (const p of ["/robots.txt", "/", "/services", "/.well-known/x402", "/openapi.json", "/llms.txt", "/discovery/resources?limit=100"]) {
  const r = await fetch(B + p); const t = await r.text();
  console.log(r.status === 200 ? "ok  " : "FAIL", r.status, p, t.length, p === "/robots.txt" ? JSON.stringify(t.slice(0, 60)) : t.includes("xrpl-token-safety") ? "(has safety)" : "");
  if (r.status !== 200) fail++;
}
process.exit(fail ? 1 : 0);
