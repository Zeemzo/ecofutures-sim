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

export async function deploy(s: Scenario, progress: (msg: string) => void = () => {}): Promise<Deployment> {
  const k = s.contracts;
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

  progress("Deploying the eleven contracts behind their proxies");
  const admin = await proxy("admin", forwarder, "initialize", []);
  const countries = await proxy("countries", forwarder, "initialize", [admin, BigInt(k.baseFee) * E18]);
  const registry = await proxy("registry", forwarder, "initialize", [admin, usdt, BigInt(k.acceptanceDays) * DAY, BigInt(k.watchdogDays) * DAY]);
  const deeds = await proxy("deeds", forwarder, "initialize", [admin, BigInt(k.backstopDays) * DAY]);
  const core = await proxy("core", forwarder, "initialize", [admin, BigInt(Math.round(k.yearDays * Number(DAY))), BigInt(k.maxVerificationDelayDays) * DAY]);
  const bank = await proxy("bank", forwarder, "initialize", [admin, usdt, serverWallet, k.verifierPermille, k.taxPermille, k.serverPermille, BigInt(k.minAuctionDays) * DAY]);
  const challenge = await proxy("challenge", forwarder, "initialize", [admin, usdt, BigInt(k.reviewDays) * DAY, BigInt(k.responseDays) * DAY, BigInt(k.panelDays) * DAY, BigInt(k.redrawDays) * DAY, k.haltAfter]);
  const governance = await proxy("governance", forwarder, "initialize", [admin]);
  const tree = await proxy("tree", forwarder, "initialize", [admin, "Tree", "TREE", BigInt(k.editionScale)]);
  const token = await proxy("token", forwarder, "initialize", [admin, "EcoFutures", "EFT", usdt]);
  const overcharge = await proxy("overcharge", forwarder, "initialize", [admin]);

  const d = { admin, countries, registry, deeds, core, bank, challenge, governance, tree, token, overcharge } as Record<string, Address>;
  const call = (key: Key, fn: string, args: unknown[] = []) => sendRaw(DEPLOYER, d[key] ?? (key === "usdt" ? usdt : "0x"), abis[key], fn, args);

  progress("Wiring the directory");
  await call("admin", "setDirectory", [d]);
  for (const key of ["countries", "registry", "deeds", "core", "bank", "challenge", "governance", "tree", "token", "overcharge"] as Key[]) await call(key, "sync");
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

  const dep = { ...d, usdt, forwarder, lens, editionScale: k.editionScale, deployedAt: 0 } as Deployment;
  setDeployment(dep);
  return dep;
}
