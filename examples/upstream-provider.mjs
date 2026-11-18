// Example third-party provider upstream. It only answers requests that carry the gateway's secret.
import http from "node:http";
const SECRET = process.env.UPSTREAM_SECRET ?? "";
http.createServer((req, res) => {
  if (!SECRET || req.headers["x-gateway-secret"] !== SECRET) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"call me through the x402 gateway"}'); }
  const u = new URL(req.url, "http://x");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ provider: "example-weather", city: u.searchParams.get("city") ?? "Miami", forecast: "sunny, 82F (demo data)", paidBy: req.headers["x-x402-payer"] ?? null }));
}).listen(Number(process.env.PORT ?? 9100), "127.0.0.1", () => console.log("upstream on :9100"));
