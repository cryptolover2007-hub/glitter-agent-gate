// Creates and funds XRPL TESTNET wallets via the public faucet.
// Seeds are written ONLY to .secrets/testnet-wallets.json (chmod 600). Never printed.
import { Client, Wallet } from "xrpl";
import fs from "node:fs";
import path from "node:path";

const WS = process.env.XRPL_TESTNET_WS ?? "wss://testnet.xrpl-labs.com";
const FILE = path.resolve(".secrets/testnet-wallets.json");
const roles = (process.argv[2] ?? "agent,provider,platform").split(",");

fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
const existing = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
const client = new Client(WS);
await client.connect();
const info = await client.request({ command: "server_info" });
if (info.result.info.network_id !== 1) throw new Error("Refusing: not XRPL testnet (network_id != 1)");
for (const role of roles) {
  if (existing[role]) { console.log(`${role}: ${existing[role].address} (already exists)`); continue; }
  const { wallet, balance } = await client.fundWallet(Wallet.generate(), { faucetHost: "faucet.altnet.rippletest.net" });
  existing[role] = { address: wallet.classicAddress, seed: wallet.seed, network: "xrpl:1" };
  fs.writeFileSync(FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  console.log(`${role}: ${wallet.classicAddress} funded with ${balance} test XRP`);
}
fs.chmodSync(FILE, 0o600);
await client.disconnect();
