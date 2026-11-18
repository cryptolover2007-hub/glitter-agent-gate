# glitter-agent-gate-mcp

<!-- mcp-name: trade.glitterchainscout.agents/agent-gate -->

MCP server (stdio) for **Glitter Agent Gate** (https://agents.glitterchainscout.trade). Each tool call is paid per request with
x402 on the XRP Ledger (XRP or RLUSD) from **your** agent wallet, with per-call and per-session spend caps. Failed calls are not charged.

Tools: `list_services` (free), `call_paid_service`, `web_to_markdown`, `xrpl_account_info`, `crypto_prices`, `convert_file`, `json_transform`.

```json
{ "mcpServers": { "glitter-agent-gate": {
  "command": "npx", "args": ["-y", "glitter-agent-gate-mcp"],
  "env": { "XRPL_SEED": "<dedicated low-balance agent seed>", "X402_ALLOW_MAINNET": "true",
           "MAX_XRP_PER_CALL": "0.1", "SESSION_BUDGET_XRP": "1" }
} } }
```

- Default gateway `https://agents.glitterchainscout.trade` (XRPL mainnet). Payments there need `X402_ALLOW_MAINNET=true`.
- Testing: `GATEWAY_URL=http://127.0.0.1:8787` with a testnet seed (network is detected from the gateway).
- Use a dedicated wallet that only holds what you are willing to spend.
