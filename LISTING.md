# Listing checklist (do this once there is a public HTTPS URL)

Researched 17 Nov 2026. **Automatic** means agents/indexers find us with no submission once the trigger happens.

| # | Channel | Automatic? | Trigger / what it needs | Link |
|---|---|---|---|---|
| 1 | **XRPL AI Hub (t54) — Index, Agora, Directory** | Semi: one submission, then automatic | Submit the origin URL once. It checks each URL returns 402 with `PAYMENT-REQUIRED` naming an XRPL network and a `payTo`, then **re-crawls `/.well-known/x402` hourly**. The Index counts settled volume by SourceTag 804681468 (we set it). It indexes **mainnet only**, so list after the mainnet launch. Optional: `/.well-known/trustline-merchant.txt` (served) and a wallet-signed proof for Trustline standing. | https://xrpl-ai.org/join/service · FAQ https://xrpl-ai.org/faq |
| 2 | **Coinbase CDP Bazaar / Agentic.Market** | **Yes**, after the first settled payment *through the CDP facilitator* | Base (or Solana) USDC rail + `bazaar` extension (already in every 402) + `paymentPayload.resource`. **CDP does not support XRPL.** Needs a CDP account + API keys (`https://api.cdp.coinbase.com/platform/v2/x402`, JWT auth). v1 uses PayAI for EVM; adding CDP auth is a small TODO. 1,000 tx/month free. | https://docs.cdp.coinbase.com/x402/bazaar · https://portal.cdp.coinbase.com |
| 3 | **PayAI facilitator discovery** | Likely yes after first Base settle (not yet verified) | PayAI supports the `bazaar` extension (`/supported`) and has a public `/discovery/resources` feed. EVM/Solana only, **no XRPL**. No API key. Our Base Sepolia payload already reaches PayAI `/verify` correctly. | https://facilitator.payai.network/discovery/resources |
| 4 | **x402scan** | Manual submit, then crawl | Reads `/openapi.json` (with `x-payment-info`) first, then `/.well-known/x402`. **Only Base and Solana resources register** (XRPL is rejected), so this needs the Base rail. | https://www.x402scan.com/resources/register · spec https://github.com/Merit-Systems/x402scan/blob/main/docs/DISCOVERY.md |
| 5 | **Official MCP Registry** | Manual publish | Publish `mcp/` to npm as `xrpl-agent-tools-mcp` (its `mcpName` must match `server.json`). Then `mcp-publisher login github` and `mcp-publisher publish` from `mcp/`. Namespace `io.github.<user>/…` needs GitHub auth; a domain namespace needs DNS/HTTP proof. Fill the `REPLACE_*` placeholders first. | https://registry.modelcontextprotocol.io · https://github.com/modelcontextprotocol/registry |
| 6 | **mcp.so** | Manual submit form | GitHub repo URL + description. | https://mcp.so/submit |
| 7 | **Glama MCP directory** | Auto-indexes public GitHub MCP repos | A public repo with an MCP server. Claim it to edit. | https://glama.ai/mcp/servers |
| 8 | **Smithery** | Manual (URL publish) | Needs a **remote Streamable-HTTP MCP endpoint**. Ours is stdio (it pays from the user's own wallet), so Smithery needs a v2 remote MCP. | https://smithery.ai (docs: https://smithery.ai/docs/build/publish) |
| 9 | **A2A** | Passive: no central registry | Agents fetch `/.well-known/agent-card.json` from our domain. Put the domain in docs, llms.txt and listings. | https://a2a-protocol.org |
| 10 | **llms.txt** | Passive | `/llms.txt` is served. LLM crawlers and agents read it directly. | https://llmstxt.org |

## Truly automatic vs needs submission
- **Automatic once traffic flows:** CDP Bazaar (Base USDC via the CDP facilitator), PayAI discovery (likely), XRPL AI Hub Index volume (SourceTag), Glama (from a public repo), and A2A/llms.txt (read directly from our domain).
- **One submission, then self-updating:** XRPL AI Hub (hourly `/.well-known/x402` crawl) and x402scan.
- **Manual each version:** MCP Registry (`mcp-publisher publish`), mcp.so and Smithery.

## The cold-start catch
CDP Bazaar only indexes after a **real settled payment** through CDP. With no starting capital, the first one can come from Johnny paying
our own `hello` endpoint once with ~$0.001 USDC on Base mainnet. That is a self-test, and it should be labeled as one, not as customer volume.
