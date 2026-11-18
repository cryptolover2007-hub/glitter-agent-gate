import type { Env } from "./types";
import { HttpError, json } from "./util";

export function checkDashboardAuth(req: Request, env: Env) {
  if (!env.DASHBOARD_TOKEN) {
    if (env.REQUIRE_DASHBOARD_TOKEN === "true") throw new HttpError(503, "dashboard disabled: DASHBOARD_TOKEN secret not set");
    return;
  }
  const u = new URL(req.url);
  const tok = u.searchParams.get("token") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (tok !== env.DASHBOARD_TOKEN) throw new HttpError(401, "dashboard token required");
}

export async function stats(env: Env): Promise<Response> {
  const [byService, byProvider, recent, calls] = await Promise.all([
    env.DB.prepare("SELECT service_slug, asset_symbol, COUNT(*) AS paid_calls, SUM(CAST(amount_display AS REAL)) AS revenue FROM settlements GROUP BY service_slug, asset_symbol ORDER BY service_slug").all(),
    env.DB.prepare("SELECT provider_id, pay_to, asset_symbol, COUNT(*) AS paid_calls, SUM(CAST(amount_display AS REAL)) AS revenue, SUM(CAST(fee_owed_display AS REAL)) AS fees_owed FROM settlements GROUP BY provider_id, pay_to, asset_symbol").all(),
    env.DB.prepare("SELECT service_slug, asset_symbol, amount_display, payer, pay_to, network, tx_hash, created_at FROM settlements ORDER BY id DESC LIMIT 25").all(),
    env.DB.prepare("SELECT service_slug, outcome, COUNT(*) AS n FROM call_log GROUP BY service_slug, outcome").all(),
  ]);
  return json({ byService: byService.results, byProvider: byProvider.results, recent: recent.results, calls: calls.results, explorerTxUrl: env.EXPLORER_TX_URL });
}

export function dashboardHtml(env: Env): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${env.GATEWAY_NAME} — dashboard</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#0f1115;color:#e6e6e6}h1{font-size:20px}h2{font-size:15px;margin-top:28px;color:#9ad}
table{border-collapse:collapse;width:100%;margin-top:6px}td,th{border-bottom:1px solid #2a2f3a;padding:6px 8px;text-align:left}th{color:#aaa;font-weight:600}
a{color:#7cc4ff}.pill{display:inline-block;padding:1px 8px;border-radius:9px;background:#243;color:#8f8;font-size:12px}.mono{font-family:ui-monospace,monospace;font-size:12px}</style></head>
<body><h1>${env.GATEWAY_NAME} <span class="pill">${env.X402_NETWORK}</span></h1>
<div id="svc"></div><h2>Paid calls & revenue by service</h2><table id="t1"></table>
<h2>Revenue by provider / payTo</h2><table id="t2"></table><h2>Call outcomes</h2><table id="t4"></table>
<h2>Recent settlements</h2><table id="t3"></table>
<script>
const tok=new URLSearchParams(location.search).get('token');const q=tok?('?token='+encodeURIComponent(tok)):'';
function tbl(id,rows,cols,fmt){const t=document.getElementById(id);t.innerHTML='<tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr>'+(rows.length?rows.map(r=>'<tr>'+cols.map(c=>'<td>'+(fmt&&fmt[c]?fmt[c](r[c],r):(r[c]??''))+'</td>').join('')+'</tr>').join(''):'<tr><td colspan=9>none yet</td></tr>')}
Promise.all([fetch('/api/stats'+q).then(r=>r.json()),fetch('/services').then(r=>r.json())]).then(([s,c])=>{
document.getElementById('svc').innerHTML='<h2>Services</h2><table>'+c.services.map(x=>'<tr><td><b>'+x.name+'</b><br><span class=mono>/s/'+x.slug+'</span></td><td>'+x.prices.map(p=>p.amountDisplay+' '+p.asset).join(' · ')+'</td><td>'+x.kind+'</td></tr>').join('')+'</table>';
tbl('t1',s.byService,['service_slug','asset_symbol','paid_calls','revenue']);
tbl('t2',s.byProvider,['provider_id','pay_to','asset_symbol','paid_calls','revenue','fees_owed']);
tbl('t4',s.calls,['service_slug','outcome','n']);
tbl('t3',s.recent,['created_at','service_slug','amount_display','asset_symbol','payer','tx_hash'],{created_at:v=>new Date(v).toLocaleString(),tx_hash:(v,r)=>r.network.startsWith('xrpl')?'<a class=mono href="'+s.explorerTxUrl+v+'" target=_blank>'+v.slice(0,16)+'…</a>':'<span class=mono>'+v.slice(0,16)+'…</span>',payer:v=>'<span class=mono>'+(v||'')+'</span>'});
});
</script></body></html>`;
}
