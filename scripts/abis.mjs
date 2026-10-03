// Copies the compiled ABIs and bytecode from the contracts' out/ into src/abi.json and src/bytecode.json, so the app
// always matches the contracts it runs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "abi.json and bytecode.json";
// The contracts: CONTRACTS_DIR, else the V11 folder this sits in (inside the contracts repo). Without either (the
// simulator on its own) the artifacts committed in src/ are used as they are.
const v11 = process.env.CONTRACTS_DIR ?? join(here, "..", "..");
if (!existsSync(join(v11, "foundry.toml")) || !existsSync(join(v11, "out"))) {
  console.log(`${NAME}: no built contracts here (set CONTRACTS_DIR to a built V11 to refresh); using the committed copy`);
  process.exit(0);
}
const out = join(v11, "out");
const names = {
  admin: "EcoFuturesAdmin", countries: "EcoCountries", registry: "EcoRegistry", deeds: "EcoDeeds",
  core: "EcoFuturesCore", bank: "EcoBank", challenge: "EcoChallenge", governance: "EcoFuturesGovernance",
  tree: "Tree", token: "EcoFuturesToken", overcharge: "EcoOvercharge", lens: "EcoLens",
};
const abis = {};
for (const [key, name] of Object.entries(names)) {
  abis[key] = JSON.parse(readFileSync(join(out, `${name}.sol`, `${name}.json`), "utf8")).abi;
}
abis.usdt = JSON.parse(readFileSync(join(out, "DeployLocal.s.sol", "LocalUSDT.json"), "utf8")).abi;
writeFileSync(join(here, "..", "src", "abi.json"), JSON.stringify(abis));
console.log(`abi.json: ${Object.keys(abis).length} contracts`);

// Creation bytecode, so the app can deploy the protocol itself with any configuration.
const code = {};
const art = (file, name) => JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8"));
for (const [key, name] of Object.entries(names)) code[key] = art(`${name}.sol`, name).bytecode.object;
code.usdt = art("DeployLocal.s.sol", "LocalUSDT").bytecode.object;
code.forwarder = art("EcoForwarder.sol", "EcoForwarder").bytecode.object;
code.proxy = art("ERC1967Proxy.sol", "ERC1967Proxy").bytecode.object;
const proxyAbi = art("ERC1967Proxy.sol", "ERC1967Proxy").abi;
writeFileSync(join(here, "..", "src", "bytecode.json"), JSON.stringify({ code, proxyAbi }));
console.log(`bytecode.json: ${Object.keys(code).length} contracts`);
