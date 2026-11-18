# How this could earn (honest version)

## Model
Sell small, reliable tools that AI agents need many times a day, priced per call, with no accounts or API keys.
Discovery is inbound: agents find the endpoints in x402 indexes (XRPL AI Hub, CDP Bazaar, x402scan), MCP directories,
A2A agent cards and llms.txt. No ad spend.

Revenue lines, in order of realism:
1. **First-party tools (v1):** web→Markdown ($0.02), XRPL/crypto data ($0.002), file conversion ($0.05), JSON utils ($0.005).
2. **Listing marketplace (secondary):** other providers list behind the gateway. Earn by (a) a recorded % fee settled later (`PLATFORM_FEE_BPS`),
   (b) a flat paid listing or featured placement, or (c) a hosted-listing plan. All of these stay non-custodial. Taking custody of others' payments would bring compliance risk.
3. **Premium tiers later:** bigger file limits, batch endpoints, cached/historical XRPL data, a hardened sandbox.

## Unit economics (approximate)
- Marginal cost per call is near zero on Cloudflare, but CPU-heavy tools likely need Workers Paid ($5/month) to be reliable.
- The XRPL network fee is paid by the buyer. Example: 1,000 web→Markdown calls/day ≈ $20/day gross, and 10,000 data calls/day ≈ $20/day.
  These are illustrations, not forecasts. With zero listings and zero traffic, revenue is zero.

## Market reality
- XRPL x402 is real and live (Ripple's AI Starter Kit, t54 facilitators, xrpl.org docs).
- The XRPL AI Hub showed millions of payments but only about **$90K settled in total**, mostly from a handful of agent fleets.
  The count is high because payments are tiny, and buyers are concentrated.
- Competitors already sell XRPL data and web-to-Markdown per call on XRPL (for example Criptonlabs, Crypto Broski, Brük and BitBooth's PageDelta).
  We need better reliability, clean schemas and low prices, not novelty.
- The Bazaar ecosystem (Base/Solana USDC) is far larger (tens of thousands of indexed resources), so offering USDC on Base as a second option matters for reach.

## What this is not
Not "passive income" and not guaranteed. Revenue depends on agents choosing these endpoints over alternatives. That needs uptime,
correct data, fair prices and ongoing maintenance (price updates when XRP moves, source API terms, abuse handling).

## Risks to manage
- Scraping: only public pages, robots.txt honored, no bypassing of captchas, logins or bot protection. Site terms still apply, so add a takedown/contact page.
- Data source terms (CoinGecko public API) for commercial use.
- XRP price swings: XRP prices are static, so re-price regularly or quote from RLUSD.
- Platform fees on third-party listings: keep them non-custodial and get advice before taking custody of payments.
