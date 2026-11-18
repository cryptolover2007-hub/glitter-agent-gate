#!/usr/bin/env python3
"""Builds .secrets/deploy-code.js: a Cloudflare-API (MCP `execute`) script that uploads the production Worker
with all [env.production] vars, the D1 binding and the two secrets from .secrets/production-tokens.json.
Used because box wrangler auth is broken. Run `npx wrangler deploy --dry-run --env production --minify --outdir /tmp/bundle-prod` first.
The output contains secrets: it is written chmod 600 under .secrets/ (gitignored). Never print it."""
import json, os, tomllib, gzip, base64
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/"
tok = json.load(open(R + ".secrets/production-tokens.json"))
cfg = tomllib.load(open(R + "wrangler.toml", "rb"))
prod = cfg["env"]["production"]
bindings = [{"type": "plain_text", "name": k, "text": v} for k, v in prod["vars"].items()]
db = prod["d1_databases"][0]
bindings.append({"type": "d1", "name": db["binding"], "id": db["database_id"]})
bindings += [{"type": "secret_text", "name": k, "text": tok[k]} for k in ("REGISTRY_ADMIN_TOKEN", "DASHBOARD_TOKEN")]
meta = {"main_module": "index.js", "compatibility_date": cfg["compatibility_date"], "compatibility_flags": cfg["compatibility_flags"],
        "bindings": bindings, "observability": {"enabled": True}}
js = open("/tmp/bundle-prod/index.js", "rb").read()
b64 = base64.b64encode(gzip.compress(js, 9)).decode()
code = """async () => {
 const b64 = %s; const meta = %s;
 const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
 const js = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 const form = new FormData();
 form.append('metadata', new Blob([JSON.stringify(meta)], {type:'application/json'}));
 form.append('index.js', new Blob([js], {type:'application/javascript+module'}), 'index.js');
 const r = await cloudflare.request({method:'PUT', path:`/accounts/${accountId}/workers/scripts/%s`, body: form});
 return {ok:r.success, id:r.result?.id, etag:r.result?.etag?.slice(0,12), size:js.byteLength};
}""" % (json.dumps(b64), json.dumps(meta), prod["name"])
out = R + ".secrets/deploy-code.js"
with open(out, "w") as f: f.write(code)
os.chmod(out, 0o600)
print("wrote", out, "bundle bytes", len(js))
