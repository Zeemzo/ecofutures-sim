// Builds src/surface.json, the explorer's map of the protocol, from what cannot disagree with the code: the
// compiled ABIs and NatSpec in ../out, and the Solidity source in ../src (who may call each function, and
// which contracts call which).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "surface.json";
// The contracts: CONTRACTS_DIR, else the V11 folder this sits in (inside the contracts repo). Without either (the
// simulator on its own) the artifacts committed in src/ are used as they are.
const v11 = process.env.CONTRACTS_DIR ?? join(here, "..", "..");
if (!existsSync(join(v11, "foundry.toml")) || !existsSync(join(v11, "out"))) {
  console.log(`${NAME}: no built contracts here (set CONTRACTS_DIR to a built V11 to refresh); using the committed copy`);
  process.exit(0);
}

const CONTRACTS = [
  ["admin", "EcoFuturesAdmin"], ["countries", "EcoCountries"], ["registry", "EcoRegistry"], ["deeds", "EcoDeeds"],
  ["core", "EcoFuturesCore"], ["bank", "EcoBank"], ["challenge", "EcoChallenge"], ["governance", "EcoFuturesGovernance"],
  ["tree", "Tree"], ["token", "EcoFuturesToken"], ["lens", "EcoLens"],
];
const KEY_OF_INTERFACE = {
  IEcoAdmin: "admin", IEcoCountries: "countries", IEcoRegistry: "registry", IEcoDeeds: "deeds", IEcoCore: "core",
  IEcoBank: "bank", IEcoChallenge: "challenge", IEcoGovernance: "governance", ITree: "tree", IEcoTree: "tree",
  IEcoToken: "token",
};
// Plumbing every contract has: hidden unless asked for.
const PLUMBING = new Set(["initialize", "sync", "directory", "pause", "unpause", "paused", "upgradeTo", "upgradeToAndCall",
  "proxiableUUID", "isTrustedForwarder", "trustedForwarder", "supportsInterface", "authorised"]);
const ROLE_NAMES = { FOUNDATION: "the Foundation", SERVER: "the server", UPGRADER: "the upgrader", HOLDER: "a Trust Admin", VERIFIER: "a verifier", GUARDIAN: "a guardian" };

const strip = (s) => s.replace(/\s+/g, " ").trim();
const sigOf = (item) => `${item.name}(${(item.inputs ?? []).map(typeStr).join(",")})`;
function typeStr(i) {
  if (i.type.startsWith("tuple")) return `(${i.components.map(typeStr).join(",")})${i.type.slice(5)}`;
  return i.type;
}

/** The NatSpec block right above `contract Name`: its @title and @notice. */
function contractDoc(src, name) {
  const at = src.search(new RegExp(`\\ncontract ${name}\\b`));
  if (at < 0) return {};
  const before = src.slice(0, at);
  const start = before.lastIndexOf("/**");
  if (start < 0 || before.slice(start).includes("*/\n\n")) return {};
  const block = before.slice(start).replace(/^\s*\/?\*+\/?/gm, "").replace(/\*\//, "");
  const title = (block.match(/@title\s+([^@]*)/) ?? [])[1];
  const notice = (block.match(/@notice\s+([^@]*)/) ?? [])[1];
  const dev = (block.match(/@dev\s+([^@]*)/) ?? [])[1];
  return { title: title && strip(title), notice: notice && strip(notice), dev: dev && strip(dev) };
}

/** Who may call a function, read from its modifiers and the first lines of its body. */
function accessOf(src, fn, mutability) {
  if (mutability === "view" || mutability === "pure") return "Anyone (a read)";
  if (fn === "initialize") return "Once, at deployment";
  const re = new RegExp(`function ${fn}\\s*\\(`, "g");
  const found = [];
  let m;
  while ((m = re.exec(src))) {
    const brace = src.indexOf("{", m.index);
    const semi = src.indexOf(";", m.index);
    if (brace < 0 || (semi >= 0 && semi < brace)) continue; // an interface declaration
    const header = src.slice(m.index, brace);
    const body = src.slice(brace, brace + 700);
    const who = [];
    for (const r of header.matchAll(/(?:authorised|onlyRole)\(Roles\.([A-Z_]+)\)/g)) who.push(`Only ${ROLE_NAMES[r[1]] ?? r[1]}`);
    for (const r of body.matchAll(/_only\(_dir\.([a-z]+)\)/g)) who.push(`Only the ${r[1] === "governance" ? "Council (Governance)" : r[1].charAt(0).toUpperCase() + r[1].slice(1)} contract`);
    if (/!_isGTA\[[^\]]+\]\) revert NotGTA/.test(body)) who.push("A GTA");
    if (/onlyRole\(Roles\.SERVER\)|_requireServer/.test(body)) who.push("Only the server");
    if (/_judge\(\)/.test(body)) who.push("A Trust Admin of the country, or the Council");
    found.push(who.length ? [...new Set(who)].join("; ") : "Anyone; the function checks its own rules");
  }
  return found[0] ?? "Anyone; the function checks its own rules";
}

/** Calls this contract makes to the others, by function. */
function callsOf(src) {
  const helper = {};
  for (const m of src.matchAll(/function (_\w+)\(\) (?:private|internal) view returns \((I\w+)\)/g)) helper[m[1]] = KEY_OF_INTERFACE[m[2]];
  const vars = {};
  for (const m of src.matchAll(/(I\w+) (\w+) = (?:(_\w+)\(\)|I\w+\(_dir\.(\w+)\))/g)) vars[m[2]] = m[4] ?? helper[m[3]] ?? KEY_OF_INTERFACE[m[1]];
  const calls = new Set();
  for (const m of src.matchAll(/\b(_\w+)\(\)\.(\w+)\(/g)) if (helper[m[1]]) calls.add(`${helper[m[1]]}.${m[2]}`);
  for (const m of src.matchAll(/\bI\w+\(_dir\.(\w+)\)\.(\w+)\(/g)) calls.add(`${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/\b(\w+)\.(\w+)\(/g)) if (vars[m[1]]) calls.add(`${vars[m[1]]}.${m[2]}`);
  return [...calls].map((c) => { const [to, fn] = c.split("."); return { to, fn }; }).filter((c) => c.to);
}

function callsFrom(key, src) {
  return callsOf(src).filter((c) => c.to !== key);
}

const files = Object.fromEntries(readdirSync(join(v11, "src")).filter((f) => f.endsWith(".sol")).map((f) => [f, readFileSync(join(v11, "src", f), "utf8")]));
const contracts = CONTRACTS.map(([key, name]) => {
  const art = JSON.parse(readFileSync(join(v11, "out", `${name}.sol`, `${name}.json`), "utf8"));
  // the contract's own source, then its base's: pause, unpause, sync and the upgrade gate live in EcoBase
  const src = (files[`${name}.sol`] ?? "") + "\n" + readFileSync(join(v11, "src", "common", "EcoBase.sol"), "utf8");
  const user = art.metadata?.output?.userdoc ?? {}, dev = art.metadata?.output?.devdoc ?? {};
  const fns = art.abi.filter((i) => i.type === "function").map((f) => {
    const sig = sigOf(f);
    const u = user.methods?.[sig] ?? {}, d = dev.methods?.[sig] ?? {};
    return {
      name: f.name, sig, mutability: f.stateMutability, read: f.stateMutability === "view" || f.stateMutability === "pure",
      inputs: f.inputs, outputs: f.outputs, notice: u.notice ? strip(u.notice) : "", details: d.details ? strip(d.details) : "",
      params: d.params ?? {}, returns: d.returns ?? {}, access: accessOf(src, f.name, f.stateMutability), plumbing: PLUMBING.has(f.name),
    };
  }).sort((a, b) => Number(a.read) - Number(b.read) || a.name.localeCompare(b.name));
  const events = art.abi.filter((i) => i.type === "event").map((e) => ({
    name: e.name, sig: sigOf(e), inputs: e.inputs, notice: strip(user.events?.[sigOf(e)]?.notice ?? ""),
    plumbing: ["DirectorySynced", "Initialized", "Upgraded", "AdminChanged", "BeaconUpgraded", "Paused", "Unpaused", "RoleAdminChanged"].includes(e.name),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const errors = art.abi.filter((i) => i.type === "error").map((e) => ({ name: e.name, sig: sigOf(e) })).sort((a, b) => a.name.localeCompare(b.name));
  const doc = contractDoc(src, name);
  const size = (art.deployedBytecode?.object?.length ?? 2) / 2 - 1;
  return { key, name, ...doc, size, functions: fns, events, errors, calls: key === "lens" ? [] : callsFrom(key, src) };
});

// the roles, from Roles in EcoTypes.sol with their comments
const types = files["common/EcoTypes.sol"] ?? readFileSync(join(v11, "src", "common", "EcoTypes.sol"), "utf8");
const roles = [];
const rolesBlock = types.slice(types.indexOf("library Roles"), types.indexOf("}", types.indexOf("library Roles")));
for (const m of rolesBlock.matchAll(/((?:[ \t]*\/\/\/[^\n]*\n)*)[ \t]*bytes32 internal constant (\w+) = ([^;]+);/g)) {
  roles.push({ name: m[2], doc: strip(m[1].replace(/\/\/\/\s?@?(dev|notice)?/g, "")) });
}
// every country, ISO 3166-1: numeric code, two letters, English name (for the setup screen's dropdown)
const iso = (await import("i18n-iso-countries")).default;
iso.registerLocale(JSON.parse(readFileSync(join(here, "..", "node_modules", "i18n-iso-countries", "langs", "en.json"), "utf8")));
const countries = Object.entries(iso.getNumericCodes()).map(([num, a2]) => [Number(num), a2, iso.getName(a2, "en", { select: "official" }) ?? a2])
  .sort((x, y) => String(x[2]).localeCompare(String(y[2])));
writeFileSync(join(here, "..", "src", "surface.json"), JSON.stringify({ contracts, roles, countries }));
const n = contracts.reduce((a, c) => a + c.functions.length, 0), e = contracts.reduce((a, c) => a + c.events.length, 0);
console.log(`surface.json: ${contracts.length} contracts, ${n} functions, ${e} events, ${contracts.reduce((a, c) => a + c.calls.length, 0)} cross-contract calls`);
