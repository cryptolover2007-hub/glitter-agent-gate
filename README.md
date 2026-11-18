# Glitter Agent Gate — x402 pay-per-call tools for AI agents

Production URL (not deployed yet): **https://agents.glitterchainscout.trade**

"The plumbing agents pay for": a Cloudflare Worker that sells small, useful tool endpoints to AI agents, paid **per call** with
[x402](https://docs.x402.org) on the XRP Ledger in **XRP or RLUSD** (via the t54 facilitator). It can also offer **USDC on Base**
as a second option in the same 402 so EVM-only buyers and the Coinbase/PayAI Bazaar indexes can find it. A secondary
marketplace lets other providers list their own APIs and get paid directly.

> Status: works end to end on **XRPL testnet** (`xrpl:1`) running locally with `wrangler dev`. A mainnet config exists
> (`wrangler.toml` → `[env.production]`) but **nothing is deployed** and no mainnet payment has been made.
> Real testnet settlements: see [`e2e/RESULTS.md`](e2e/RESULTS.md).

## What it sells (v1)

| Slug | What | Price (XRP / RLUSD / USDC) | Johnny's range |
|---|---|---|---|
| `web-markdown` | Public web page → clean Markdown (Readability). Honors robots.txt. **No captcha/paywall/bot-protection bypass**; blocked pages return an error and are not charged. | 0.02 / 0.02 / 0.02 | $0.01–0.03 |
| `xrpl-data` | `/account` (balance, reserve, spendable, trust lines, last 10 txs), `/token` (issuer, supply, XRP AMM price), `/prices` (CoinGecko). Mainnet or testnet ledgers. | 0.002 / 0.002 / 0.002 | $0.001–0.005 |
| `convert` | PDF / CSV / TSV / XLSX / HTML → JSON or text. Raw bytes, or JSON `{url}` / `{content_base64}`. 10 MB max. | 0.05 / 0.05 / 0.05 | $0.02–0.10 |
| `json-tools` | Safe deterministic JSON ops (pick, flatten, sort_by, dedupe, to_csv…). No eval, no user regex. | 0.005 / 0.005 / 0.005 | ~$0.005 (sandbox slot) |
| `hello` | Smallest paid call, for testing clients. | 0.0001 / 0.0001 / 0.001 | — |

XRP prices assume ≈ US$0.98/XRP (CoinGecko, 17 Nov 2026). Re-check before mainnet; XRP prices are static in `src/catalog.ts`.
A code sandbox is intentionally **not** in v1 (security risk). Later option: a locked-down sandbox on a separate Worker.

## Architecture

```
agent ──GET /s/xrpl-data/account?address=r…──▶ Worker (src/index.ts)
      ◀── 402 + PAYMENT-REQUIRED (accepts: XRP, RLUSD on xrpl:1 [+ USDC on Base]) + bazaar extension
agent signs XRPL Payment (x402-xrpl SDK, invoice-bound, SourceTag 804681468)
      ──retry with PAYMENT-SIGNATURE──▶ Worker
           1. look up invoice in D1, match the exact option (amount/asset/payTo/invoiceId)
           2. POST facilitator /verify   (t54 for xrpl:*, PayAI for eip155:*)
           3. claim invoice atomically (no double use)
           4. run the tool (or proxy to a listed provider's upstream)
              └ tool failed → invoice re-opens, nothing settled, X-402-Charged: false
           5. POST facilitator /settle → tx hash
              └ settle failed → result withheld (never given away free)
           6. record settlement in D1 → 200 + result + PAYMENT-RESPONSE
```

- **Non-custodial.** Buyers pay the service's `payTo` directly on-ledger. The facilitator only submits the buyer-signed blob. The gateway never holds keys or funds.
- **Storage:** D1 (`invoices`, `settlements`, `call_log`, `providers`, `listed_services`). Schema: `migrations/0001_init.sql`.
- **Safety rails:** mainnet refused unless `ALLOW_MAINNET="true"`; inputs validated *before* the 402 so nobody pays for a bad request; replay/underpayment/cross-service invoice reuse rejected (`e2e/security-tests.ts`); SSRF guard on user URLs; size caps; robots.txt.

### Files
- `src/index.ts` router · `src/x402.ts` 402/verify/settle logic + Bazaar extension · `src/catalog.ts` own services and prices
- `src/services/*` tool implementations · `src/registry.ts` marketplace listings + proxy · `src/discovery.ts` manifests · `src/dashboard.ts`
- `clients/ts/agent-demo.ts` XRPL agent client · `clients/ts/agent-demo-base.ts` Base USDC client · `mcp/` MCP server + `server.json`
- `e2e/` results, security tests, tx verifier · `examples/upstream-provider.mjs` sample listed provider · `scripts/` testnet wallet setup
- `LISTING.md` where to register once live · `BUSINESS.md` how it could earn, honestly

## Discovery endpoints (all free)

| Path | What |
|---|---|
| `/services` | JSON catalog for agents (prices, endpoints, params, examples) |
| `/discovery/resources` | x402 v2 spec §8.1 Bazaar-format listing (`?network=&payTo=&limit=&offset=`) |
| `/.well-known/x402` | Fan-out catalog (URL list, x402scan format) — crawled hourly by the XRPL AI Hub once registered |
| `/.well-known/agent-card.json` (+ legacy `/.well-known/agent.json`) | A2A v1.0 Agent Card; `/a2a` answers `SendMessage` with call instructions + prices |
| `/openapi.json` | OpenAPI 3.1 with `x-payment-info` (x402scan reads this first) |
| `/llms.txt` | Plain-text guide for LLMs |
| `/.well-known/trustline-merchant.txt` | Binds the domain to the payout wallet (t54 Trustline standing) |
| `/dashboard`, `/api/stats` | Calls, revenue per service and per provider (production fails closed with 503 until the `DASHBOARD_TOKEN` secret is set) |

Every 402 also carries the official `bazaar` extension (generated with `@x402/extensions/bazaar` `declareDiscoveryExtension`).

## Run the demo locally (testnet)

```bash
cd /workspace/x402-gateway
npm install
npm run wallets          # creates + faucet-funds testnet wallets -> .secrets/testnet-wallets.json (chmod 600)
npm run rlusd            # trust lines + buys 2 test RLUSD from the testnet XRP/RLUSD AMM
npm run db:migrate
npm run dev              # http://127.0.0.1:8787   (optional: --var BASE_PAY_TO:0x… to show the Base rail)

npm run demo -- --service hello --query name=johnny
npm run demo -- --service xrpl-data --path /account --query "address=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" --asset RLUSD
npm run demo -- --service web-markdown --query "url=https://xrpl.org/docs/agents/agentic-payments-x402"
npm run demo -- --service convert --method POST --file e2e/fixtures/sample.pdf --content-type application/pdf
npm run test:security    # replay / underpayment / cross-service reuse
npm run test:mcp         # MCP server over stdio, one paid call
npm run verify:txs       # re-checks every logged tx on the testnet ledger -> e2e/RESULTS.md
```
Open http://127.0.0.1:8787/dashboard for calls and revenue.

## How an agent pays
Use any x402 v2 client. For XRPL: `npm i x402-xrpl` (or `pip install x402-xrpl`) and wrap fetch:
```ts
import { x402Fetch } from "x402-xrpl"; import { Wallet } from "xrpl";
const paid = x402Fetch({ wallet: Wallet.fromSeed(process.env.XRPL_SEED!), network: "xrpl:0" }); // "xrpl:1" + http://127.0.0.1:8787 for local testnet
const r = await paid("https://agents.glitterchainscout.trade/s/xrpl-data/prices?ids=ripple"); // production = xrpl:0
```
The SDK picks an option, signs an invoice-bound XRPL `Payment`, retries with `PAYMENT-SIGNATURE`, and the gateway returns `PAYMENT-RESPONSE` (`{success, transaction, network, payer}`).
Claude/other MCP clients: see `mcp/README.md` (per-call and per-session spend caps built in).

## How a provider lists a service (secondary marketplace)
```bash
curl -X POST https://agents.glitterchainscout.trade/api/services -H "authorization: Bearer $REGISTRY_ADMIN_TOKEN" -H 'content-type: application/json' -d '{
  "slug":"my-weather","name":"Weather","description":"…","upstream_url":"https://api.example.com/weather",
  "price_xrp":"0.001","price_rlusd":"0.001","pay_to":"rYourXRPLAddress","tags":["weather"]}'
```
Returns a `providerKey` (manage/deactivate) and an `upstreamSecret`; the upstream receives `X-Gateway-Secret` on every paid call and
should reject anything else. `REGISTRATION_MODE` = `admin` (default) | `open` | `closed`. Buyers pay `pay_to` directly.

**Platform fee trade-off.** x402 `exact` is one payment to one `payTo`, so a fee can't be split on-ledger without custody. Options:
1. *v1 default:* fee 0%. Pay provider directly. Simplest and fully non-custodial.
2. *Fee ledger (implemented):* set `PLATFORM_FEE_BPS` (e.g. `100` = 1%). Each settlement records `fee_owed`; bill providers later. Non-custodial, but needs trust/collection.
3. *Custodial:* gateway is `payTo`, then pays providers out. Easy fee capture, but holding others' money brings money-transmission/compliance risk. Not built.
Listing fees or a premium placement in `/services` are the other non-custodial routes.

## Configs
| | Default (`npm run dev`) | `--env production` |
|---|---|---|
| Worker | `glitter-agent-gate-dev` (never deployed) | `glitter-agent-gate` |
| URL | http://127.0.0.1:8787 | https://agents.glitterchainscout.trade (Custom Domain, created on deploy) |
| XRPL | `xrpl:1` testnet, t54 testnet facilitator, testnet RLUSD issuer | `xrpl:0` mainnet, t54 mainnet facilitator, RLUSD `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` |
| XRP/RLUSD payTo | testnet wallet `rPdrpP…` | `rELk9NdWK29x3qmfw3mHrLi7L6GPbvhFPi` (RLUSD trust line verified) |
| Base USDC | Base Sepolia `eip155:84532` | Base `eip155:8453`, USDC `0x8335…2913`, payTo `0xEd31…3d7a` |
| Fee / registration | 0% / admin | 0% / admin |
| Dashboard | open locally | needs `DASHBOARD_TOKEN` secret (fails closed) |
| D1 | `glitter-agent-gate-dev` (local) | `glitter-agent-gate` (**not created yet**, id `PENDING_D1_CREATE`) |

## Launch (needs Johnny's go-ahead for every step)
1. `npx wrangler d1 create glitter-agent-gate` → paste the id into `[[env.production.d1_databases]]`.
2. `npx wrangler d1 migrations apply glitter-agent-gate --env production --remote`
3. `npx wrangler secret put REGISTRY_ADMIN_TOKEN --env production` and `npx wrangler secret put DASHBOARD_TOKEN --env production`
4. `npx wrangler deploy --env production` → creates the `agents.glitterchainscout.trade` DNS record + certificate.
5. Smoke test: `curl -i https://agents.glitterchainscout.trade/s/hello` must return 402 with `xrpl:0` and `payTo` `rELk9…`.
6. Then list it (see `LISTING.md`).

## Costs
- **Cloudflare:** Workers Free = 100k requests/day but only **10 ms CPU per request**. `xrpl-data`, `json-tools` and `hello` are I/O-bound and fit. `web-markdown` (DOM parsing) and `convert` (PDF/XLSX) can exceed 10 ms on big inputs, so plan on **Workers Paid ($5/month minimum)** once those get traffic. D1 free tier (5M row reads, 100k row writes/day) is plenty. Bundle ≈ 1.1 MB gzipped (under the 3 MB free limit). Check Cloudflare's pricing page before launch, these numbers can change.
- **XRPL:** the buyer pays the network fee (~0.00001 XRP). Receiving costs nothing. An RLUSD trust line locks a 0.2 XRP owner reserve.
- **Facilitators:** t54 hosted: I found no published fee (confirm at support@t54.ai). PayAI: no API key needed. CDP: 1,000 tx/month free, then $0.001/tx, and it needs CDP API keys.
- **Upstream data:** CoinGecko's public API is rate-limited and has its own terms. For commercial volume, budget for a paid key or switch sources (on-ledger AMM prices are free).
