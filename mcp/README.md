# xrpl-agent-tools-mcp

<!-- mcp-name: io.github.REPLACE_GITHUB_USER/xrpl-agent-tools -->

MCP server (stdio) for the XRPL Agent Tools gateway. Each tool call is paid per request with x402 on the XRP Ledger
(XRP or RLUSD) from **your** agent wallet, with per-call and per-session spend caps. Failed calls are not charged.

Tools: `list_services` (free), `call_paid_service`, `web_to_markdown`, `xrpl_account_info`, `crypto_prices`, `convert_file`, `json_transform`.

```json
{ "mcpServers": { "xrpl-agent-tools": {
  "command": "npx", "args": ["-y", "xrpl-agent-tools-mcp"],
  "env": { "XRPL_SEED": "<dedicated testnet agent seed>", "GATEWAY_URL": "http://127.0.0.1:8787", "X402_NETWORK": "xrpl:1" }
} } }
```

Use a dedicated wallet that only holds what you are willing to spend. Mainnet needs `X402_NETWORK=xrpl:0` **and** `X402_ALLOW_MAINNET=true`.
