export interface Env {
  DB: D1Database;
  GATEWAY_NAME: string;
  X402_NETWORK: string;
  ALLOW_MAINNET: string;
  FACILITATOR_URL: string;
  OWN_PAY_TO: string;
  RLUSD_ISSUER: string;
  XRPL_RPC_TESTNET: string;
  XRPL_RPC_MAINNET: string;
  EXPLORER_TX_URL: string;
  PLATFORM_FEE_BPS: string;
  REGISTRATION_MODE: string;
  ALLOW_HTTP_UPSTREAM: string;
  INVOICE_TTL_SECONDS: string;
  CONTACT_URL: string;
  PUBLIC_BASE_URL: string;
  BASE_NETWORK: string;
  BASE_USDC: string;
  BASE_PAY_TO: string;
  EVM_FACILITATOR_URL: string;
  REQUIRE_DASHBOARD_TOKEN: string;
  MCP_REGISTRY_AUTH: string;
  DAILY_SUMMARY?: string;
  DISCORD_WEBHOOK_URL?: string;
  REGISTRY_ADMIN_TOKEN?: string; // secret (.dev.vars / wrangler secret)
  DASHBOARD_TOKEN?: string;      // secret; if set, /dashboard + /api/stats require it
}

export interface Price {
  xrpDrops?: string; // XRP price in drops (1 XRP = 1,000,000 drops)
  rlusd?: string;    // RLUSD price as a decimal value string
  usdc?: string;     // USDC (Base) price as a decimal value string, e.g. "0.02"
}

/** A paid endpoint. Own services run in-process; listed services proxy to an upstream. */
export interface PaidService {
  slug: string;
  name: string;
  description: string;
  kind: "own" | "listed";
  providerId: string; // "own" for first-party
  payTo: string;
  price: Price;
  tags: string[];
  /** Sub-routes for docs/discovery. path is relative to /s/<slug> */
  routes: RouteDoc[];
  upstreamUrl?: string;
  upstreamSecret?: string;
  method?: string;
  /** Cheap checks run BEFORE the 402 so agents never pay for a malformed request. */
  validate?: (req: Request, subpath: string) => void;
  handler?: (req: Request, env: Env, subpath: string) => Promise<Response>;
}

export interface RouteDoc {
  path: string;            // "" or "/account"
  method: "GET" | "POST";
  summary: string;
  query?: Record<string, { type: string; description: string; required?: boolean; example?: string }>;
  body?: { contentTypes: string[]; description: string };
  outputExample?: unknown;
}

export type Handler = (req: Request, env: Env, subpath: string) => Promise<Response>;
