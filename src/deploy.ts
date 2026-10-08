// Deploys the whole V11 protocol to the local chain with a scenario's configuration: the same sequence as
// script/local/DeployLocal.s.sol, from the compiled bytecode, so the app needs no Foundry to run.
import { encodeFunctionData, getAddress, keccak256, toBytes, type Abi, type Address, type Hex } from "viem";
import { abis, labelAddress, setDeployment, sendRaw, deployRaw, type Deployment, type Key } from "./chain";
import type { Scenario } from "./config";
import code from "./bytecode.json";

const DEPLOYER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"); // anvil's first account
const DAY = 86_400n;
const E18 = 10n ** 18n;
const SERVER_ROLE = keccak256(toBytes("SERVER_ADMIN_ROLE"));
const C = (code as any).code as Record<string, Hex>;
const proxyAbi = (code as any).proxyAbi as Abi;

/** An address the plan names before it exists: resolved as the contracts are deployed. */
type Ref = { ref: "admin" | "usdt" | "serverWallet" };
/** One argument of an initializer: the value sent, and how the setup screen shows it. */
export type PlanArg = { value: unknown; shown: string };
/** The ten proxies in the order they are deployed, each with what its initializer is given. The setup screen shows
 *  this plan and deploy() sends it, so what is shown is what is deployed. */
export function initPlan(s: Scenario): { key: Key; args: PlanArg[] }[] {
  const k = s.contracts;
  const days = (n: number): PlanArg => ({ value: BigInt(n) * DAY, shown: `${n} days` });
  const usd = (n: number): PlanArg => ({ value: BigInt(n) * E18, shown: `${n.toLocaleString("en-US")} USDT` });
  const permille = (n: number): PlanArg => ({ value: n, shown: `${n}‰ (${n / 10}% of each sale)` });
  const text = (t: string): PlanArg => ({ value: t, shown: `"${t}"` });
  const ref = (r: Ref["ref"], shown: string): PlanArg => ({ value: { ref: r } satisfies Ref, shown });
  const admin = ref("admin", "the Admin proxy"), usdt = ref("usdt", "the settlement currency (test USDT)");
  return [
    { key: "admin", args: [] },
    { key: "countries", args: [admin, usd(k.baseFee)] },
    { key: "registry", args: [admin, usdt, days(k.acceptanceDays), days(k.watchdogDays)] },
    { key: "deeds", args: [admin, days(k.backstopDays)] },
    { key: "core", args: [admin, { value: BigInt(Math.round(k.yearDays * Number(DAY))), shown: `${k.yearDays} days` }, days(k.maxVerificationDelayDays)] },
    { key: "bank", args: [admin, usdt, ref("serverWallet", "the server's wallet"), permille(k.verifierPermille), permille(k.taxPermille), permille(k.serverPermille), days(k.minAuctionDays)] },
    { key: "challenge", args: [admin, usdt, days(k.reviewDays), days(k.responseDays), days(k.panelDays), days(k.redrawDays), { value: k.haltAfter, shown: `${k.haltAfter} unattested windows in a row` }] },
    { key: "governance", args: [admin] },
    { key: "tree", args: [admin, text("Tree"), text("TREE"), { value: BigInt(k.editionScale), shown: `${k.editionScale.toLocaleString("en-US")} land-years × F²` }] },
    { key: "token", args: [admin, text("EcoFutures"), text("EFT"), usdt] },
  ];
}

export async function deploy(s: Scenario, progress: (msg: string) => void = () => {}): Promise<Deployment> {
  const init = (key: Key, fn: string, args: unknown[]) => encodeFunctionData({ abi: abis[key], functionName: fn, args });
  const make = async (bytecode: Hex, abi: Abi, args: unknown[] = []) => deployRaw(DEPLOYER, abi, bytecode, args);
  const proxy = async (key: Key, fwd: Address, initFn: string, initArgs: unknown[]) => {
    const impl = await make(C[key], abis[key], [fwd]);
    return make(C.proxy, proxyAbi, [impl, init(key, "initialize", initArgs)]);
  };

  progress("Deploying the settlement currency and the forwarder");
  const usdt = await make(C.usdt, abis.usdt);
  const forwarder = await make(C.forwarder, [] as Abi);
  const server = labelAddress("server"), serverWallet = labelAddress("serverWallet");

  progress("Deploying the ten contracts behind their proxies");
  const d = {} as Record<string, Address>;
  const known: Record<Ref["ref"], () => Address> = { admin: () => d.admin, usdt: () => usdt, serverWallet: () => serverWallet };
  for (const { key, args } of initPlan(s)) {
    d[key] = await proxy(key, forwarder, "initialize", args.map((a) => (a.value as Ref)?.ref ? known[(a.value as Ref).ref]() : a.value));
  }
  const admin = d.admin;
  const call = (key: Key, fn: string, args: unknown[] = []) => sendRaw(DEPLOYER, d[key] ?? (key === "usdt" ? usdt : "0x"), abis[key], fn, args);

  progress("Wiring the directory");
  await call("admin", "setDirectory", [d]);
  for (const key of ["countries", "registry", "deeds", "core", "bank", "challenge", "governance", "tree", "token"] as Key[]) await call(key, "sync");
  const lens = await make(C.lens, abis.lens, [admin]);

  progress("Granting the server role and seating the Council");
  await call("admin", "grantRole", [SERVER_ROLE, server]);
  for (let i = 1; i <= 3; i++) await call("governance", "seatGTA", [labelAddress(`gta${i}`), `ipfs://gta${i}`]);

  progress("Defining the flows and enabling the countries");
  for (const f of s.flows) await call("countries", "defineFlow", [f.id, f.steps]);
  for (const c of s.countries) {
    await call("countries", "enableCountry", [
      c.code,
      { flowId: c.flowId, minTermYears: c.minTerm, maxTermYears: c.maxTerm, listingWindow: Number(BigInt(c.listingDays) * DAY), postSaleWindow: Number(BigInt(c.postSaleDays) * DAY) },
      { baseFee: BigInt(c.baseFee) * E18, attestationFee: BigInt(c.attestationFee) * E18, judgmentFee: BigInt(c.judgmentFee) * E18 },
    ]);
  }

  const dep = { ...d, usdt, forwarder, lens, editionScale: s.contracts.editionScale, deployedAt: 0 } as Deployment;
  setDeployment(dep);
  return dep;
}
