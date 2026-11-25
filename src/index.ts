import { dailySummary, notifyAlert } from "./notify";
import type { Env, PaidService } from "./types";
import { ownServices } from "./catalog";
import { getListed, listedServices, proxyUpstream, registerService, deactivateService } from "./registry";
import { handlePaid, isMainnetAllowed, refreshSolanaRail } from "./x402";
import { a2aRpc, agentCard, discoveryResources, llmsTxt, openapi, servicesCatalog, wellKnownX402 } from "./discovery";
import { checkDashboardAuth, dashboardHtml, stats } from "./dashboard";
import { corsHeaders, HttpError, json } from "./util";
import { handleMcp } from "./mcp-http";

async function allServices(env: Env): Promise<PaidService[]> {
  return [...ownServices(env), ...(await listedServices(env).catch(() => []))];
}

const worker = {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dailySummary(env).catch((e) => console.warn("daily summary failed", String(e).slice(0, 120))));
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, "");
    const p = url.pathname;
    try {
      isMainnetAllowed(env);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

      // ---- paid services ----
      const m = p.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/);
      if (m) {
        const slug = m[1];
        const subpath = (m[2] ?? "").replace(/\/+$/, "");
        const own = ownServices(env).find((s) => s.slug === slug);
        const svc = own ?? (await getListed(env, slug));
        if (!svc) return json({ error: "unknown service", catalog: `${origin}/services` }, 404);
        const publicUrl = `${origin}${p}${url.search}`;
        return await handlePaid(req, env, svc, subpath, publicUrl, (payer) =>
          svc.kind === "own" ? svc.handler!(req, env, subpath) : proxyUpstream(req, env, svc, subpath, payer), ctx);
      }

      // ---- hosted MCP ----
      if (p === "/mcp") return await handleMcp(req, env, origin, ownServices(env), (r) => worker.fetch(r, env, ctx));

      // ---- discovery ----
      if (p === "/robots.txt") return new Response(ROBOTS(origin), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
      if (["/", "/services", "/discovery/resources", "/.well-known/x402", "/llms.txt", "/openapi.json", "/.well-known/agent-card.json", "/.well-known/agent.json", "/a2a"].includes(p)) await refreshSolanaRail(env);
      if (p === "/" ) return json({ name: env.GATEWAY_NAME, network: env.X402_NETWORK, docs: `${origin}/llms.txt`, services: `${origin}/services`, dashboard: `${origin}/dashboard` });
      if (p === "/services") return json(servicesCatalog(env, origin, await allServices(env)));
      if (p === "/discovery/resources") return json(discoveryResources(env, origin, await allServices(env), url.searchParams));
      if (p === "/.well-known/x402") return json(wellKnownX402(env, origin, await allServices(env)));
      if (p === "/.well-known/agent-card.json" || p === "/.well-known/agent.json") return json(agentCard(env, origin, ownServices(env)), 200, { "content-type": "application/json" });
      if (p === "/a2a" && req.method === "POST") return await a2aRpc(req, env, origin, ownServices(env));
      if (p === "/llms.txt") return new Response(llmsTxt(env, origin, await allServices(env)), { headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders() } });
      if (p === "/openapi.json") return json(openapi(env, origin, await allServices(env)));
      if (p === "/favicon.ico" || p === "/favicon.svg") return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
      if (p === "/.well-known/mcp-registry-auth") return env.MCP_REGISTRY_AUTH ? new Response(env.MCP_REGISTRY_AUTH + "\n", { headers: { "content-type": "text/plain" } }) : json({ error: "not found" }, 404);
      if (p === "/.well-known/trustline-merchant.txt") return new Response(`xrpl:${env.OWN_PAY_TO}\n`, { headers: { "content-type": "text/plain" } });

      // ---- marketplace (secondary) ----
      if (p === "/api/services" && req.method === "POST") return await registerService(req, env);
      const d = p.match(/^\/api\/services\/([a-z0-9-]+)$/);
      if (d && req.method === "DELETE") return await deactivateService(req, env, d[1]);

      // ---- dashboard ----
      if (p === "/api/stats") { checkDashboardAuth(req, env); return await stats(env); }
      if (p === "/dashboard") { checkDashboardAuth(req, env); return new Response(dashboardHtml(env), { headers: { "content-type": "text/html; charset=utf-8" } }); }
      // Token-gated test posts to the private Discord section (labelled TEST). Same auth as the dashboard.
      if (p === "/api/notify-test" && req.method === "POST") {
        checkDashboardAuth(req, env);
        notifyAlert(env, ctx, { kind: "internal_error", detail: "Operator-triggered test. Not a real outage.", test: true });
        ctx.waitUntil(dailySummary(env, { test: true }).catch((e) => console.warn("test summary failed", String(e).slice(0, 120))));
        return json({ ok: true, posted: ["alerts", "activity"], label: "TEST" });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      // Pathname only — never the query string (dashboard token may be in it).
      notifyAlert(env, ctx, { kind: "internal_error", status: 500, detail: `${req.method} ${p}: ${String((e as any)?.message ?? e).slice(0, 180)}` });
      return json({ error: "internal_error" }, 500);
    }
  },
};

export default worker;

const ROBOTS = (origin: string) => `# Glitter Agent Gate: x402 pay-per-call API for AI agents. Crawlers welcome.
# Paid endpoints under /s/ answer HTTP 402 with x402 payment requirements (no charge for probing).
User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /api/

# Agent docs: ${origin}/llms.txt
# x402 catalog: ${origin}/.well-known/x402
# OpenAPI: ${origin}/openapi.json
# MCP (streamable HTTP): ${origin}/mcp
`;
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd76a"/><stop offset="1" stop-color="#c77dff"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="#14111f"/><path d="M44 22a14 14 0 1 0 2 14H33" fill="none" stroke="url(#g)" stroke-width="7" stroke-linecap="round"/><circle cx="49" cy="14" r="3" fill="#ffd76a"/></svg>`;
