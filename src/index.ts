import type { Env, PaidService } from "./types";
import { ownServices } from "./catalog";
import { getListed, listedServices, proxyUpstream, registerService, deactivateService } from "./registry";
import { handlePaid, isMainnetAllowed } from "./x402";
import { a2aRpc, agentCard, discoveryResources, llmsTxt, openapi, servicesCatalog, wellKnownX402 } from "./discovery";
import { checkDashboardAuth, dashboardHtml, stats } from "./dashboard";
import { corsHeaders, HttpError, json } from "./util";

async function allServices(env: Env): Promise<PaidService[]> {
  return [...ownServices(env), ...(await listedServices(env).catch(() => []))];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
          svc.kind === "own" ? svc.handler!(req, env, subpath) : proxyUpstream(req, env, svc, subpath, payer));
      }

      // ---- discovery ----
      if (p === "/" ) return json({ name: env.GATEWAY_NAME, network: env.X402_NETWORK, docs: `${origin}/llms.txt`, services: `${origin}/services`, dashboard: `${origin}/dashboard` });
      if (p === "/services") return json(servicesCatalog(env, origin, await allServices(env)));
      if (p === "/discovery/resources") return json(discoveryResources(env, origin, await allServices(env), url.searchParams));
      if (p === "/.well-known/x402") return json(wellKnownX402(env, origin, await allServices(env)));
      if (p === "/.well-known/agent-card.json" || p === "/.well-known/agent.json") return json(agentCard(env, origin, ownServices(env)), 200, { "content-type": "application/json" });
      if (p === "/a2a" && req.method === "POST") return await a2aRpc(req, env, origin, ownServices(env));
      if (p === "/llms.txt") return new Response(llmsTxt(env, origin, await allServices(env)), { headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders() } });
      if (p === "/openapi.json") return json(openapi(env, origin, await allServices(env)));
      if (p === "/.well-known/mcp-registry-auth") return env.MCP_REGISTRY_AUTH ? new Response(env.MCP_REGISTRY_AUTH + "\n", { headers: { "content-type": "text/plain" } }) : json({ error: "not found" }, 404);
      if (p === "/.well-known/trustline-merchant.txt") return new Response(`xrpl:${env.OWN_PAY_TO}\n`, { headers: { "content-type": "text/plain" } });

      // ---- marketplace (secondary) ----
      if (p === "/api/services" && req.method === "POST") return await registerService(req, env);
      const d = p.match(/^\/api\/services\/([a-z0-9-]+)$/);
      if (d && req.method === "DELETE") return await deactivateService(req, env, d[1]);

      // ---- dashboard ----
      if (p === "/api/stats") { checkDashboardAuth(req, env); return await stats(env); }
      if (p === "/dashboard") { checkDashboardAuth(req, env); return new Response(dashboardHtml(env), { headers: { "content-type": "text/html; charset=utf-8" } }); }

      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal_error" }, 500);
    }
  },
};
