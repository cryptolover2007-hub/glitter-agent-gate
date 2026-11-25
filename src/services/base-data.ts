// Base mainnet data: balances, token info, latest block, tx status, recent ERC-20 transfers.
// Every node error is a 502 and an empty transfer window is a 404, so nothing empty or broken is ever charged.
import type { Env } from "../types";
import { HttpError, json } from "../util";
import { balanceOf, erc20Info, isEvmAddr, pad32, rpc, units } from "./evm";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hexN = (n: number) => "0x" + n.toString(16);

export function validateBaseData(req: Request, subpath: string) {
  const q = new URL(req.url).searchParams;
  const need = (k: string, re: RegExp, msg: string) => { if (!re.test(q.get(k) ?? "")) throw new HttpError(400, msg); };
  const addr = /^0x[0-9a-fA-F]{40}$/;
  switch (subpath) {
    case "/balance": need("address", addr, "missing or invalid ?address= (0x wallet)"); if (q.get("token") && !isEvmAddr(q.get("token"))) throw new HttpError(400, "invalid ?token="); break;
    case "/token": need("address", addr, "missing or invalid ?address= (0x token contract)"); break;
    case "/block": break;
    case "/tx": need("hash", /^0x[0-9a-fA-F]{64}$/, "missing or invalid ?hash= (0x + 64 hex)"); break;
    case "/transfers": need("token", addr, "missing or invalid ?token= (0x token contract)"); if (q.get("address") && !isEvmAddr(q.get("address"))) throw new HttpError(400, "invalid ?address="); break;
    default: throw new HttpError(404, "unknown route; use /balance, /token, /block, /tx or /transfers");
  }
}

async function getLogsBackwards(env: Env, filter: Record<string, unknown>, latest: number, window: number, want: number, firstChunk = 1000) {
  // Walk back from the latest block in chunks; public nodes cap ranges/results, so shrink the chunk on errors.
  const logs: any[] = []; let chunk = Math.min(window, firstChunk); let to = latest; const floor = latest - window;
  while (to > floor && logs.length < want) {
    const from = Math.max(floor + 1, to - chunk + 1);
    try {
      const r: any[] = await rpc(env, "eth_getLogs", [{ ...filter, fromBlock: hexN(from), toBlock: hexN(to) }], 12000);
      logs.unshift(...r); to = from - 1;
    } catch (e) {
      if (chunk <= 25) throw e; // nodes really are failing: 502, not charged
      chunk = Math.floor(chunk / 4);
    }
  }
  return { logs, scannedFrom: to + 1 };
}

export async function baseDataHandler(req: Request, env: Env, subpath: string): Promise<Response> {
  const q = new URL(req.url).searchParams;
  if (subpath === "/balance") {
    const a = q.get("address")!, t = q.get("token");
    const wei = BigInt(await rpc(env, "eth_getBalance", [a, "latest"]));
    const out: any = { chain: "base", address: a, eth: units(wei, 18) };
    if (t) { const [info, bal] = await Promise.all([erc20Info(env, t), balanceOf(env, t, a)]); if (info.decimals == null) throw new HttpError(404, "token is not an ERC-20 on Base (not charged)"); out.token = { ...info, balance: units(bal, info.decimals) }; }
    return json(out);
  }
  if (subpath === "/token") {
    const a = q.get("address")!;
    const info = await erc20Info(env, a);
    if (!info.symbol && !info.name && info.decimals == null) throw new HttpError(404, "not an ERC-20 token on Base (not charged)");
    return json({ chain: "base", ...info });
  }
  if (subpath === "/block") {
    const b = await rpc(env, "eth_getBlockByNumber", ["latest", false]);
    if (!b?.number) throw new HttpError(502, "Base node returned no block (not charged)");
    return json({ chain: "base", number: parseInt(b.number, 16), hash: b.hash, timestamp: new Date(parseInt(b.timestamp, 16) * 1000).toISOString(), transactions: b.transactions.length, gasUsed: parseInt(b.gasUsed, 16), baseFeeGwei: b.baseFeePerGas ? parseInt(b.baseFeePerGas, 16) / 1e9 : null });
  }
  if (subpath === "/tx") {
    const h = q.get("hash")!;
    const [tx, rc] = await Promise.all([rpc(env, "eth_getTransactionByHash", [h]), rpc(env, "eth_getTransactionReceipt", [h])]);
    if (!tx) throw new HttpError(404, "transaction not found on Base (not charged)");
    return json({ chain: "base", hash: h, from: tx.from, to: tx.to, valueEth: units(BigInt(tx.value), 18), block: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
      status: rc ? (rc.status === "0x1" ? "success" : "failed") : "pending", gasUsed: rc ? parseInt(rc.gasUsed, 16) : null, logs: rc ? rc.logs.length : null, contractCreated: rc?.contractAddress ?? null });
  }
  // /transfers
  const token = q.get("token")!, who = q.get("address");
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const latest = parseInt(await rpc(env, "eth_blockNumber", []), 16);
  const window = who ? 43_200 : 1_800; // ~24 h for one wallet, ~1 h for a whole token (2 s blocks)
  const base = { address: token, topics: [TRANSFER] as (string | null)[] };
  let logs: any[], scannedFrom: number;
  if (who) {
    const [a, b] = await Promise.all([getLogsBackwards(env, { address: token, topics: [TRANSFER, "0x" + pad32(who)] }, latest, window, limit, 10_000), getLogsBackwards(env, { address: token, topics: [TRANSFER, null, "0x" + pad32(who)] }, latest, window, limit, 10_000)]);
    logs = [...a.logs, ...b.logs].sort((x, y) => parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16)); scannedFrom = Math.max(a.scannedFrom, b.scannedFrom);
  } else ({ logs, scannedFrom } = await getLogsBackwards(env, base, latest, window, limit));
  logs = logs.filter((l) => l.topics?.length >= 3);
  if (!logs.length) throw new HttpError(404, `no ERC-20 transfers found in the last ${latest - scannedFrom + 1} blocks (not charged)`);
  const info = await erc20Info(env, token);
  return json({ chain: "base", token: { address: token, symbol: info.symbol, decimals: info.decimals }, filter: who ?? null, blocks: { from: scannedFrom, to: latest },
    count: Math.min(limit, logs.length), transfers: logs.slice(-limit).reverse().map((l) => ({ tx: l.transactionHash, block: parseInt(l.blockNumber, 16), from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), amount: units(BigInt(l.data === "0x" ? 0 : l.data), info.decimals) })) });
}
