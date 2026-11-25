// Base ERC-20 token check (issuer powers, proxy/upgradeability, pools) and honeypot/tax simulation.
// Simulation: a small simulator contract (source: Sim.sol.txt) is injected with eth_call state overrides, so nothing is
// deployed or sent on-chain and no API keys are needed. It buys with WETH (or WETH->USDC), transfers 1%, then sells.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Env } from "../types";
import { HttpError, json } from "../util";
import SIM from "./sim-bytecode.json";
import { addrFromWord, balanceOf, erc20Info, ethCall, isEvmAddr, isZero, pad32, rpc, USDC, WETH, word } from "./evm";

const V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const V2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const SIM_ADDR = "0x00000000000000000000000000000000005151a1";
const SLOTS = {
  eip1967Impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  zosImpl: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  zosAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
  eip1822: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
};
const POWERS: Record<string, string[]> = {
  mint: ["40c10f19", "a0712d68", "4e44d956"],
  pause: ["8456cb59"],
  blacklist: ["f9f92be4", "0ecb93c0", "44337ea1", "153b0d1e", "455a4396", "fe575a87", "e47d6060"],
  setFees: ["c647b20e", "52f7c988"],
  maxTx: ["ec28438a"],
  tradingSwitch: ["8a8c523c", "c2e5ec04"],
};
const hasSel = (code: string, sel: string) => code.includes("63" + sel); // PUSH4 <selector> in the dispatcher

export function validateBaseToken(req: Request) {
  const a = new URL(req.url).searchParams.get("address");
  if (!isEvmAddr(a)) throw new HttpError(400, "missing or invalid ?address= (0x token contract on Base)");
}

async function storage(env: Env, a: string, slot: string) { return addrFromWord(await rpc(env, "eth_getStorageAt", [a, slot, "latest"])); }

async function proxyInfo(env: Env, a: string, code: string) {
  const m = code.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i);
  if (m) return { isProxy: true, type: "EIP-1167 minimal proxy (not upgradeable)", upgradeable: false, implementation: "0x" + m[1], admin: null };
  const [impl, beacon, admin, zImpl, zAdmin, uups] = await Promise.all([SLOTS.eip1967Impl, SLOTS.eip1967Beacon, SLOTS.eip1967Admin, SLOTS.zosImpl, SLOTS.zosAdmin, SLOTS.eip1822].map((s) => storage(env, a, s)));
  if (!isZero(impl)) return { isProxy: true, type: "EIP-1967 upgradeable proxy", upgradeable: true, implementation: impl, admin: isZero(admin) ? null : admin };
  if (!isZero(beacon)) { const bi = addrFromWord(await ethCall(env, beacon!, "0x5c60da1b")); return { isProxy: true, type: "EIP-1967 beacon proxy", upgradeable: true, implementation: bi, admin: beacon }; }
  if (!isZero(zImpl)) return { isProxy: true, type: "ZeppelinOS/FiatToken upgradeable proxy", upgradeable: true, implementation: zImpl, admin: isZero(zAdmin) ? null : zAdmin };
  if (!isZero(uups)) return { isProxy: true, type: "EIP-1822 (UUPS) proxy", upgradeable: true, implementation: uups, admin: null };
  return { isProxy: false, type: null, upgradeable: false, implementation: null, admin: null };
}

type Pool = { dex: "uniswap-v3" | "uniswap-v2" | "aerodrome"; dexId: 1 | 2 | 3; quote: "WETH" | "USDC"; quoteAddr: string; fee: number; stable: boolean; pool: string; quoteLiquidity: number; liquidityUsd: number };

async function ethUsd(env: Env): Promise<number> {
  const r = await ethCall(env, V2_ROUTER, encodeFunctionData({ abi: [{ type: "function", name: "getAmountsOut", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address[]" }], outputs: [{ type: "uint256[]" }] }], functionName: "getAmountsOut", args: [10n ** 18n, [WETH, USDC]] }));
  const w = word(r, 3); return w ? Number(BigInt(w)) / 1e6 : 3000;
}

export async function findPools(env: Env, token: string): Promise<Pool[]> {
  const usd = await ethUsd(env);
  const cands: Array<Omit<Pool, "pool" | "quoteLiquidity" | "liquidityUsd"> & { call: [string, string] }> = [];
  for (const [quote, qa] of [["WETH", WETH], ["USDC", USDC]] as const) {
    for (const fee of [100, 500, 3000, 10000]) cands.push({ dex: "uniswap-v3", dexId: 1, quote, quoteAddr: qa, fee, stable: false, call: [V3_FACTORY, "0x1698ee82" + pad32(token) + pad32(qa) + fee.toString(16).padStart(64, "0")] });
    cands.push({ dex: "uniswap-v2", dexId: 2, quote, quoteAddr: qa, fee: 3000, stable: false, call: [V2_FACTORY, "0xe6a43905" + pad32(token) + pad32(qa)] });
    for (const stable of [false, true]) cands.push({ dex: "aerodrome", dexId: 3, quote, quoteAddr: qa, fee: 0, stable, call: [AERO_FACTORY, "0x79bc57d5" + pad32(token) + pad32(qa) + pad32(stable ? "1" : "0")] });
  }
  const found = await Promise.all(cands.map(async (c) => {
    const p = addrFromWord(await ethCall(env, c.call[0], c.call[1]));
    if (isZero(p)) return null;
    const qb = Number(await balanceOf(env, c.quoteAddr, p!)) / (c.quote === "WETH" ? 1e18 : 1e6);
    const { call, ...rest } = c;
    return { ...rest, pool: p!, quoteLiquidity: +qb.toPrecision(6), liquidityUsd: Math.round(c.quote === "WETH" ? qb * usd : qb) } as Pool;
  }));
  return (found.filter(Boolean) as Pool[]).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

const SIM_ABI = SIM.abi as any;
export async function simulate(env: Env, token: string, pools: Pool[]) {
  // Fee-on-transfer tokens cannot be sold on Uniswap v3 by design, so prefer v2-style pools with real liquidity.
  const usable = pools.filter((p) => p.liquidityUsd >= 50);
  const pick = usable.find((p) => p.dexId !== 1) ?? usable[0];
  if (!pick) return { simulated: false, reason: "no pool with at least $50 of WETH/USDC liquidity to simulate against" };
  const ethIn = 2n * 10n ** 15n; // 0.002 ETH (~$6); simulated, nothing is spent
  const data = encodeFunctionData({ abi: SIM_ABI, functionName: "run", args: [token, pick.quoteAddr, pick.pool, pick.dexId, pick.fee, pick.stable, ethIn] });
  const out = await ethCall(env, SIM_ADDR, data, { [SIM_ADDR]: { code: SIM.code, balance: "0x8AC7230489E80000" } }, "0x1C9C380");
  if (!out) throw new HttpError(502, "simulation call failed on every Base node (not charged)");
  const [r, err] = decodeFunctionResult({ abi: SIM_ABI, functionName: "run", data: out as `0x${string}` }) as [bigint[], string];
  const pct = (num: bigint, den: bigint) => (den > 0n ? Math.max(0, Number(((num * 100000n) / den)) / 1000) : null);
  const stage = Number(r[8]);
  const buyTax = stage === 0 || stage >= 2 ? pct(r[1] - r[2], r[1]) : null;
  const transferTax = r[3] > 0n && stage !== 2 ? pct(r[3] - r[4], r[3]) : null;
  // Aerodrome moves its swap fee (input side) out of the pool to a fee contract, so subtract it from the measured sell side.
  const aeroFeePct = pick.dexId === 3 ? Number(BigInt((await ethCall(env, AERO_FACTORY, "0xcc56b2c5" + pad32(pick.pool) + pad32(pick.stable ? "1" : "0"))) ?? "0x0")) / 100 : 0;
  const rawSell = stage === 0 ? (r[6] > r[5] ? 0 : pct(r[5] - r[6], r[5])) : null;
  const sellTax = rawSell == null ? null : Math.max(0, +(rawSell - aeroFeePct).toFixed(3));
  const roundTripLoss = stage === 0 ? pct(r[0] - r[7], r[0]) : null;
  return {
    simulated: true, pool: { dex: pick.dex, pair: `TOKEN/${pick.quote}`, address: pick.pool, ...(pick.dexId === 1 ? { feePercent: pick.fee / 10000 } : pick.dexId === 3 ? { stable: pick.stable } : {}), liquidityUsd: pick.liquidityUsd },
    simulatedBuy: `0.002 ETH${pick.quote === "USDC" ? " (swapped to USDC first)" : ""}`,
    canBuy: stage === 0 || stage >= 2, canTransfer: stage === 0 || stage === 3, canSell: stage === 0,
    buyTaxPercent: buyTax, transferTaxPercent: transferTax, sellTaxPercent: sellTax, roundTripLossPercent: roundTripLoss,
    sellExceedsInput: stage === 0 && r[6] > r[5] ? "pool received more tokens than sold (token swaps its own fees on sell); sell tax shown as 0, check roundTripLossPercent" : undefined,
    failure: stage === 0 ? null : { stage: ["ok", "buy", "transfer", "sell", "setup"][stage], reason: err || null },
    honeypot: stage === 3 || stage === 2 || (sellTax != null && sellTax >= 50),
  };
}

function riskOf(flags: Array<{ level: string }>) {
  return flags.some((f) => f.level === "high") ? "high" : flags.some((f) => f.level === "medium") ? "elevated" : flags.some((f) => f.level === "low") ? "moderate" : "low";
}

export async function honeypotHandler(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("address")!;
  const info = await erc20Info(env, token);
  if (!info.symbol && !info.name && info.decimals == null) throw new HttpError(404, "not an ERC-20 token on Base (not charged)");
  const pools = await findPools(env, token);
  const sim = await simulate(env, token, pools);
  const flags: Array<{ level: string; code: string; message: string }> = [];
  if (!sim.simulated) flags.push({ level: "high", code: "no_liquidity", message: sim.reason! });
  else {
    if (sim.honeypot) flags.push({ level: "high", code: "honeypot", message: `Simulated ${sim.failure?.stage ?? "sell"} failed or was taxed ≥50%: ${sim.failure?.reason ?? `sell tax ${sim.sellTaxPercent}%`}` });
    if (!sim.canBuy) flags.push({ level: "high", code: "cannot_buy", message: `Simulated buy failed: ${sim.failure?.reason}` });
    for (const [k, v] of [["buy", sim.buyTaxPercent], ["sell", sim.sellTaxPercent], ["transfer", sim.transferTaxPercent]] as const)
      if (v != null && v >= 1) flags.push({ level: v >= 10 ? "high" : v >= 5 ? "medium" : "low", code: `${k}_tax`, message: `${k} tax about ${v}%` });
  }
  return json({ chain: "base", token: info, riskLevel: riskOf(flags), riskFlags: flags, simulation: sim, poolsFound: pools.length,
    notes: ["Simulated with eth_call state overrides at the latest block; nothing was sent on-chain.", "Anti-bot rules that trigger on real blocks, wallet age or later blocks cannot be detected.", "Aerodrome Slipstream (concentrated) and other DEXes are not simulated."],
    disclaimer: "Automated simulation, informational only, not financial advice." });
}

export async function baseTokenHandler(req: Request, env: Env): Promise<Response> {
  const token = new URL(req.url).searchParams.get("address")!;
  const code: string = await rpc(env, "eth_getCode", [token, "latest"]);
  if (!code || code === "0x") throw new HttpError(404, "no contract at this address on Base (not charged)");
  const info = await erc20Info(env, token);
  if (!info.symbol && !info.name && info.decimals == null) throw new HttpError(404, "not an ERC-20 token (not charged)");
  const proxy = await proxyInfo(env, token, code);
  let logic = code;
  if (proxy.implementation && !isZero(proxy.implementation)) { const ic: string = await rpc(env, "eth_getCode", [proxy.implementation, "latest"]); if (ic && ic !== "0x") logic = ic; }
  const powers = Object.fromEntries(Object.entries(POWERS).map(([k, sels]) => [k, sels.some((s) => hasSel(logic, s))])) as Record<string, boolean>;
  const ownerW = await ethCall(env, token, "0x8da5cb5b") ?? await ethCall(env, token, "0x893d20e8");
  const owner = addrFromWord(ownerW), ownerRenounced = !owner || isZero(owner) || /^0x0*dead$/i.test(owner);
  const pausedW = powers.pause ? await ethCall(env, token, "0x5c975abb") : null;
  const paused = pausedW ? BigInt(pausedW) === 1n : null;
  const pools = await findPools(env, token);
  const sim = await simulate(env, token, pools);
  const liq = pools.reduce((s, p) => s + p.liquidityUsd, 0);
  const flags: Array<{ level: string; code: string; message: string }> = [];
  const add = (level: string, code: string, message: string) => flags.push({ level, code, message });
  if (paused) add("high", "paused", "Transfers are paused right now.");
  if (proxy.upgradeable) add("medium", "upgradeable", `${proxy.type}: the admin${proxy.admin ? ` (${proxy.admin})` : ""} can replace the token's code.`);
  if (powers.mint && !ownerRenounced) add("medium", "mintable", "A mint function exists and the contract has an active owner/minter: supply can grow.");
  if (powers.pause) add(ownerRenounced && !proxy.upgradeable ? "low" : "medium", "pausable", "The contract can pause transfers.");
  if (powers.blacklist) add("medium", "blacklist", "The contract can blacklist (freeze) individual addresses.");
  if (powers.setFees && !ownerRenounced) add("medium", "adjustable_fees", "The owner can change buy/sell fees.");
  if (powers.tradingSwitch && !ownerRenounced) add("low", "trading_switch", "The owner controls a trading on/off switch.");
  if (!ownerRenounced && !powers.mint && !powers.pause && !powers.blacklist) add("low", "has_owner", `The contract has an owner (${owner}).`);
  if (!pools.length) add("high", "no_pools", "No Uniswap v2/v3 or Aerodrome pool against WETH or USDC.");
  else if (liq < 10000) add("medium", "thin_liquidity", `Only about $${liq.toLocaleString("en-US")} of WETH/USDC liquidity in known pools.`);
  if (sim.simulated) {
    if (sim.honeypot) add("high", "honeypot", `Simulated ${sim.failure?.stage ?? "sell"} failed or was taxed ≥50%: ${sim.failure?.reason ?? `sell tax ${sim.sellTaxPercent}%`}`);
    for (const [k, v] of [["buy", sim.buyTaxPercent], ["sell", sim.sellTaxPercent]] as const) if (v != null && v >= 1) add(v >= 10 ? "high" : v >= 5 ? "medium" : "low", `${k}_tax`, `${k} tax about ${v}%`);
  }
  return json({
    chain: "base", token: info, riskLevel: riskOf(flags), riskFlags: flags,
    controls: { owner: ownerRenounced ? null : owner, ownerRenounced, proxy, powers, paused },
    pools: pools.slice(0, 8), liquidityUsdApprox: liq, simulation: sim,
    notChecked: ["holder distribution (needs an indexer)", "Aerodrome Slipstream and other DEXes", "off-chain/team claims"],
    disclaimer: "Automated on-chain checks and simulation, informational only, not financial advice.",
  });
}
