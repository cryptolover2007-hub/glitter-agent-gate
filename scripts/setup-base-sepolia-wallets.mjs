// Generates Base SEPOLIA (testnet) EVM keys for the optional USDC rail. Keys go ONLY to
// .secrets/base-sepolia-wallets.json (chmod 600). Never fund these on mainnet.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
const FILE = ".secrets/base-sepolia-wallets.json";
const w = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
for (const role of ["agent", "receiver"]) {
  if (!w[role]) { const pk = generatePrivateKey(); w[role] = { address: privateKeyToAccount(pk).address, privateKey: pk, network: "eip155:84532", note: "TESTNET ONLY" }; }
  console.log(`${role}: ${w[role].address}`);
}
fs.writeFileSync(FILE, JSON.stringify(w, null, 2), { mode: 0o600 }); fs.chmodSync(FILE, 0o600);
