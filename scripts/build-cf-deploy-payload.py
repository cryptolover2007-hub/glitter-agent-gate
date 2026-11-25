#!/usr/bin/env python3
"""Builds .secrets/deploy-code.js: a Cloudflare-API (MCP `execute`) script that uploads the production Worker
with the live production plain-text vars, the D1 binding, existing secrets, and optional new Discord secrets.
Used because box wrangler auth is broken. Run `npx wrangler deploy --dry-run --env production --minify --outdir /tmp/bundle-prod` first.
The output contains secrets: it is written chmod 600 under .secrets/ (gitignored). Never print it.

Keeps the 26 bindings that were live on v1.2 (does not add wrangler-only vars such as SOLANA_PAY_TO)
and appends any extra secret_text bindings listed in .secrets/discord-private-webhooks.json.
"""
import json, os, tomllib, gzip, base64
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/"
tok = json.load(open(R + ".secrets/production-tokens.json"))
cfg = tomllib.load(open(R + "wrangler.toml", "rb"))
prod = cfg["env"]["production"]

# Exact plain-text binding set from the live v1.2 worker (22 vars). Do not add extras from wrangler.toml.
KEEP_PLAIN = {
    "ALLOW_HTTP_UPSTREAM", "ALLOW_MAINNET", "BASE_NETWORK", "BASE_PAY_TO", "BASE_USDC",
    "CONTACT_URL", "DAILY_SUMMARY", "EVM_FACILITATOR_URL", "EXPLORER_TX_URL", "FACILITATOR_URL",
    "GATEWAY_NAME", "INVOICE_TTL_SECONDS", "MCP_REGISTRY_AUTH", "OWN_PAY_TO", "PLATFORM_FEE_BPS",
    "PUBLIC_BASE_URL", "REGISTRATION_MODE", "REQUIRE_DASHBOARD_TOKEN", "RLUSD_ISSUER",
    "X402_NETWORK", "XRPL_RPC_MAINNET", "XRPL_RPC_TESTNET",
}
missing = KEEP_PLAIN - set(prod["vars"])
extra = set(prod["vars"]) - KEEP_PLAIN
if missing:
    raise SystemExit(f"wrangler production.vars missing live bindings: {sorted(missing)}")
if extra:
    print("note: omitting wrangler production.vars not in the live 26-binding set:", sorted(extra))

bindings = [{"type": "plain_text", "name": k, "text": prod["vars"][k]} for k in sorted(KEEP_PLAIN)]
db = prod["d1_databases"][0]
bindings.append({"type": "d1", "name": db["binding"], "id": db["database_id"]})
bindings += [{"type": "secret_text", "name": k, "text": tok[k]} for k in ("REGISTRY_ADMIN_TOKEN", "DASHBOARD_TOKEN")]
_wh = R + ".secrets/discord-payments-webhook.json"
if os.path.exists(_wh):
    bindings.append({"type": "secret_text", "name": "DISCORD_WEBHOOK_URL", "text": json.load(open(_wh))["DISCORD_WEBHOOK_URL"]})
_priv = R + ".secrets/discord-private-webhooks.json"
if os.path.exists(_priv):
    priv = json.load(open(_priv))
    for k in ("DISCORD_WEBHOOK_PAYMENTS", "DISCORD_WEBHOOK_ALERTS", "DISCORD_WEBHOOK_ACTIVITY"):
        if k not in priv or not priv[k]:
            raise SystemExit(f"missing {k} in discord-private-webhooks.json")
        bindings.append({"type": "secret_text", "name": k, "text": priv[k]})

# Must include every one of the original 26 names.
REQUIRED_26 = KEEP_PLAIN | {"DB", "DASHBOARD_TOKEN", "DISCORD_WEBHOOK_URL", "REGISTRY_ADMIN_TOKEN"}
have = {b["name"] for b in bindings}
if not REQUIRED_26 <= have:
    raise SystemExit(f"deploy bindings missing {sorted(REQUIRED_26 - have)}")

meta = {
    "main_module": "index.js",
    "compatibility_date": cfg["compatibility_date"],
    "compatibility_flags": cfg["compatibility_flags"],
    "bindings": bindings,
    "observability": {
        "enabled": True,
        "head_sampling_rate": 1,
        "redact_query_string": False,
        "logs": {"enabled": True, "head_sampling_rate": 1, "persist": True, "invocation_logs": True},
        "traces": {"enabled": False, "persist": True, "head_sampling_rate": 1},
    },
}
js = open("/tmp/bundle-prod/index.js", "rb").read()
b64 = base64.b64encode(gzip.compress(js, 9)).decode()
# Report binding names only in a preamble comment inside the JS? Don't. Return names from the execute result.
code = """async () => {
 const b64 = %s; const meta = %s;
 const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
 const js = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 const form = new FormData();
 form.append('metadata', new Blob([JSON.stringify(meta)], {type:'application/json'}));
 form.append('index.js', new Blob([js], {type:'application/javascript+module'}), 'index.js');
 const r = await cloudflare.request({method:'PUT', path:`/accounts/${accountId}/workers/scripts/%s`, body: form});
 const crons = %s;
 let sched = null;
 if (crons.length) { const s = await cloudflare.request({method:'PUT', path:`/accounts/${accountId}/workers/scripts/%s/schedules`, body: crons.map(c => ({cron: c}))}); sched = s.result; }
 const names = (meta.bindings || []).map(b => ({name: b.name, type: b.type}));
 return {ok:r.success, id:r.result?.id, etag:r.result?.etag?.slice(0,12), size:js.byteLength, schedules: sched, bindings_count: names.length, binding_names: names.map(b => b.name), compatibility_flags: meta.compatibility_flags};
}""" % (json.dumps(b64), json.dumps(meta), prod["name"], json.dumps(prod.get("triggers", {}).get("crons", [])), prod["name"])
out = R + ".secrets/deploy-code.js"
with open(out, "w") as f: f.write(code)
os.chmod(out, 0o600)
# Do not print secrets. Print counts and names only.
print("wrote", out, "bundle bytes", len(js), "bindings", len(bindings), "names", [b["name"] for b in bindings])
