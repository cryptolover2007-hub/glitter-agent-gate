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
  const attempts = env.DB.prepare("SELECT created_at, service_slug, stage, outcome, status, network, asset, amount, payer, tx_hash, detail, user_agent, caller_kind FROM payment_attempts WHERE stage != 'probe' ORDER BY id DESC LIMIT 50").all().catch(() => ({ results: [] as any[] }));
  const attemptStats = env.DB.prepare("SELECT outcome, network, COUNT(*) AS n FROM payment_attempts WHERE stage != 'probe' GROUP BY outcome, network ORDER BY n DESC").all().catch(() => ({ results: [] as any[] }));
  // Caller directory (merged from the v2 draft): who calls, from what network, and whether they ever try to pay. No IPs stored.
  const callers = env.DB.prepare(`SELECT caller_kind, substr(user_agent,1,80) AS user_agent, as_org, country, COUNT(*) AS calls, SUM(stage != 'probe') AS pay_attempts, SUM(outcome = 'paid') AS paid, MAX(created_at) AS last_seen
    FROM payment_attempts WHERE created_at > ? GROUP BY caller_kind, substr(user_agent,1,80), as_org ORDER BY calls DESC LIMIT 60`).bind(Date.now() - 7 * 864e5).all().catch(() => ({ results: [] as any[] }));
  const [byService, byProvider, recent, calls] = await Promise.all([
    env.DB.prepare("SELECT service_slug, asset_symbol, COUNT(*) AS paid_calls, SUM(CAST(amount_display AS REAL)) AS revenue FROM settlements GROUP BY service_slug, asset_symbol ORDER BY service_slug").all(),
    env.DB.prepare("SELECT provider_id, pay_to, asset_symbol, COUNT(*) AS paid_calls, SUM(CAST(amount_display AS REAL)) AS revenue, SUM(CAST(fee_owed_display AS REAL)) AS fees_owed FROM settlements GROUP BY provider_id, pay_to, asset_symbol").all(),
    env.DB.prepare("SELECT service_slug, asset_symbol, amount_display, payer, pay_to, network, tx_hash, created_at FROM settlements ORDER BY id DESC LIMIT 25").all(),
    env.DB.prepare("SELECT service_slug, outcome, COUNT(*) AS n FROM call_log GROUP BY service_slug, outcome").all(),
  ]);
  return json({ byService: byService.results, byProvider: byProvider.results, recent: recent.results, calls: calls.results,
    attempts: (await attempts).results, attemptStats: (await attemptStats).results, callers: (await callers).results, explorerTxUrl: env.EXPLORER_TX_URL });
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
<h2>Who is calling (last 7 days; no IPs stored)</h2><table id="t7"></table><h2>Payment attempts by outcome</h2><table id="t5"></table><h2>Recent payment attempts (every request that carried a payment)</h2><table id="t6"></table>
<script>
const tok=new URLSearchParams(location.search).get('token');const q=tok?('?token='+encodeURIComponent(tok)):'';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function tbl(id,rows,cols,fmt){const t=document.getElementById(id);t.innerHTML='<tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr>'+(rows.length?rows.map(r=>'<tr>'+cols.map(c=>'<td>'+(fmt&&fmt[c]?fmt[c](r[c],r):esc(r[c]))+'</td>').join('')+'</tr>').join(''):'<tr><td colspan=9>none yet</td></tr>')}
Promise.all([fetch('/api/stats'+q).then(r=>r.json()),fetch('/services').then(r=>r.json())]).then(([s,c])=>{
document.getElementById('svc').innerHTML='<h2>Services</h2><table>'+c.services.map(x=>'<tr><td><b>'+esc(x.name)+'</b><br><span class=mono>/s/'+esc(x.slug)+'</span></td><td>'+x.prices.map(p=>p.amountDisplay+' '+p.asset).join(' · ')+'</td><td>'+x.kind+'</td></tr>').join('')+'</table>';
tbl('t1',s.byService,['service_slug','asset_symbol','paid_calls','revenue']);
tbl('t2',s.byProvider,['provider_id','pay_to','asset_symbol','paid_calls','revenue','fees_owed']);
tbl('t4',s.calls,['service_slug','outcome','n']);
tbl('t7',s.callers||[],['caller_kind','calls','pay_attempts','paid','user_agent','as_org','country','last_seen'],{last_seen:v=>new Date(v).toLocaleString()});
tbl('t5',s.attemptStats||[],['outcome','network','n']);
tbl('t6',s.attempts||[],['created_at','service_slug','stage','outcome','status','network','amount','asset','payer','detail','user_agent'],{created_at:v=>new Date(v).toLocaleString(),payer:v=>'<span class=mono>'+esc(v)+'</span>',user_agent:v=>esc(String(v||'').slice(0,60))});
tbl('t3',s.recent,['created_at','service_slug','amount_display','asset_symbol','payer','tx_hash'],{created_at:v=>new Date(v).toLocaleString(),tx_hash:(v,r)=>r.network.startsWith('xrpl')?'<a class=mono href="'+esc(s.explorerTxUrl+v)+'" target=_blank>'+esc(String(v).slice(0,16))+'…</a>':'<a class=mono href="https://basescan.org/tx/'+esc(v)+'" target=_blank>'+esc(String(v).slice(0,16))+'…</a>',payer:v=>'<span class=mono>'+esc(v)+'</span>'});
});
</script></body></html>`;
}
