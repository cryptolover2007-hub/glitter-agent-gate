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
  SOLANA_PAY_TO?: string;   // Solana USDC receiving wallet (defaults to Johnny's on mainnet); "" disables the rail
  SOLANA_NETWORK?: string;  // CAIP-2, defaults to Solana mainnet when X402_NETWORK=xrpl:0, else devnet
  SOLANA_RPC_URL?: string;
  SOLANA_RAIL?: string;       // "on" forces the Solana option, "off" disables it; unset = auto (on when payTo has a USDC token account)
  SOLANA_PAY_TO_ATA?: string; // USDC associated token account of SOLANA_PAY_TO (needed for non-default payTo)
  DISCORD_WEBHOOK_URL?: string;       // kept bound (staff #stats); new posts do not use it
  DISCORD_WEBHOOK_PAYMENTS?: string;  // private #agent-gate-payments
  DISCORD_WEBHOOK_ALERTS?: string;    // private #agent-gate-alerts
  DISCORD_WEBHOOK_ACTIVITY?: string;  // private #agent-gate-activity (daily summary)
  REGISTRY_ADMIN_TOKEN?: string; // secret (.dev.vars / wrangler secret)
  DASHBOARD_TOKEN?: string;
  BASE_RPC_URL?: string;      // optional preferred Base RPC (fallbacks are built in)
  AI?: { run(model: string, input: unknown): Promise<unknown> }; // optional Workers AI binding (not bound in v1.2; web-ai is extractive)
  AI_DAILY_CAP?: string;      // daily cap on AI calls when AI is bound (atomic counter in gate_kv)      // secret; if set, /dashboard + /api/stats require it
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
