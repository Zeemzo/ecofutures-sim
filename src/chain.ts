// The connection to the local anvil node: reads, impersonated writes, the chain's clock, and event decoding.
import {
  createPublicClient, createTestClient, createWalletClient, decodeEventLog, getAddress, http, keccak256, toBytes,
  BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex, type Log,
} from "viem";
import { foundry } from "viem/chains";
import rawAbis from "./abi.json";

export type Key =
  | "admin" | "countries" | "registry" | "deeds" | "core" | "bank" | "challenge" | "governance" | "tree" | "token"
  | "overcharge" | "lens" | "usdt";

export const abis = rawAbis as unknown as Record<Key, Abi>;
/** The node: ?rpc= (the desktop app passes its own anvil's), else VITE_RPC, else RPC (Node), else 8545. */
export const RPC: string =
  (typeof location !== "undefined" ? new URLSearchParams(location.search).get("rpc") : null)
  ?? (import.meta as any).env?.VITE_RPC ?? (globalThis as any).process?.env?.RPC ?? "http://127.0.0.1:8545";

// Serial reads go one per request (no batching delay); bulk reads are batched into a few HTTP calls.
/** Calls by method, for profiling: (globalThis as any).rpcCounts. */
export const rpcCounts: Record<string, number> = {};
(globalThis as any).rpcCounts = rpcCounts;
const count = async (req: Request) => {
  try {
    const body = await req.clone().json();
    for (const r of Array.isArray(body) ? body : [body]) rpcCounts[r.method] = (rpcCounts[r.method] ?? 0) + 1;
  } catch {}
};
const serial = http(RPC, { retryCount: 0, onFetchRequest: count });
const batched = http(RPC, { batch: { batchSize: 250, wait: 0 }, retryCount: 0, onFetchRequest: count });
export const pub = createPublicClient({ chain: foundry, transport: serial, cacheTime: 0 });
export const bulk = createPublicClient({ chain: foundry, transport: batched, cacheTime: 0 });
const wallet = createWalletClient({ chain: foundry, transport: serial });
const test = createTestClient({ chain: foundry, mode: "anvil", transport: serial });

export type Deployment = Record<Key | "forwarder", Address> & { editionScale: number; deployedAt: number };
export let addr = {} as Deployment;
const byAddress = new Map<string, Key>();

/** Every custom error of every contract, so a revert that bubbles up from another contract still decodes. */
const allErrors: Abi = (() => {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const k of Object.keys(abis) as Key[]) {
    for (const item of abis[k]) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (!seen.has(sig)) { seen.add(sig); out.push(item); }
    }
  }
  return out;
})();
const withErrors = (abi: Abi): Abi => [...abi.filter((i) => i.type !== "error"), ...allErrors];
const writeAbi = new Map<Key, Abi>((Object.keys(abis) as Key[]).map((k) => [k, withErrors(abis[k])]));

/** Point the app at a deployment: the addresses every read, write and decoded event uses. */
export function setDeployment(dep: Deployment) {
  addr = dep;
  addr.editionScale = Number(addr.editionScale);
  addr.deployedAt = Number(addr.deployedAt ?? 0);
  byAddress.clear();
  for (const k of Object.keys(abis) as Key[]) if (addr[k]) byAddress.set(getAddress(addr[k]).toLowerCase(), k);
}

/** Each transaction is mined as it is sent (send() mines it), so its receipt is there at once. Each block is one
 *  second after the last unless the clock sets its time: block times then follow from what was sent, never from how
 *  long the computer took, so a run replays to the second (travel in time depends on it). */
export async function prepareChain() {
  await test.setAutomine(false);
  await test.setBlockTimestampInterval({ interval: 1 });
}

export async function loadDeployment(given?: Deployment): Promise<Deployment> {
  if (given) setDeployment(given);
  else {
    const res = await fetch(`/deployment.json?${Date.now()}`);
    if (!res.ok) throw new Error("deployment.json not found.");
    setDeployment(await res.json());
  }
  await prepareChain();
  return addr;
}

/** A labelled address, the same derivation as DeployLocal: address(uint160(uint256(keccak256(label)))). */
export function labelAddress(label: string): Address {
  return getAddress(`0x${keccak256(toBytes(label)).slice(-40)}`);
}

export const readCounts: Record<string, number> = {};
export const timing = { send: 0, sendWrite: 0, sendMine: 0, sendReceipt: 0, sends: 0 };
export async function read<T = any>(c: Key, fn: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
  if (blockNumber === undefined) readCounts[`${c}.${fn}`] = (readCounts[`${c}.${fn}`] ?? 0) + 1;
  const client = blockNumber === undefined ? pub : bulk;
  return (await client.readContract({ address: addr[c], abi: abis[c], functionName: fn, args, blockNumber })) as T;
}

export type Sent = { ok: true; hash: Hex } | { ok: false; error: string };

/** A transaction from any address: anvil runs with --auto-impersonate. */
/** Called with every transaction an actor sends, for tests that compare runs. */
export const sendHook: { fn: ((from: Address, c: Key, fn: string, args: readonly unknown[]) => void) | null } = { fn: null };

export async function send(from: Address, c: Key, fn: string, args: readonly unknown[] = []): Promise<Sent> {
  sendHook.fn?.(from, c, fn, args);
  try {
    // chain: null skips viem's chain-id check on every send; automine is off, so the block is mined here
    const t0 = performance.now();
    const hash = await wallet.writeContract({
      account: from, address: addr[c], abi: writeAbi.get(c)!, functionName: fn, args, chain: null,
      // a fixed limit: without one anvil estimates gas first, running the call many times over
      gas: 25_000_000n,
    });
    const t1 = performance.now();
    await test.mine({ blocks: 1 });
    const t2 = performance.now();
    const rc = await receipt(hash);
    const t3 = performance.now();
    timing.sends++; timing.sendWrite += t1 - t0; timing.sendMine += t2 - t1; timing.sendReceipt += t3 - t2;
    if (rc.status !== "success") {
      // anvil mines a reverted transaction without its reason: replay it where it ran to recover the error
      try {
        await pub.simulateContract({ account: from, address: addr[c], abi: writeAbi.get(c)!, functionName: fn, args, blockNumber: rc.blockNumber - 1n });
      } catch (e) {
        return { ok: false, error: errorName(e) };
      }
      return { ok: false, error: "reverted at its block's time (the same call passes a block earlier)" };
    }
    return { ok: true, hash };
  } catch (e) {
    return { ok: false, error: errorName(e) };
  }
}

/** A deployment step: from the deployer, mined, and fatal if it fails. */
export async function sendRaw(from: Address, to: Address, abi: Abi, fn: string, args: readonly unknown[] = []): Promise<void> {
  const hash = await wallet.writeContract({ account: from, address: to, abi: withErrors(abi), functionName: fn, args, chain: null, gas: 25_000_000n });
  await test.mine({ blocks: 1 });
  const rc = await receipt(hash);
  if (rc.status !== "success") {
    try {
      await pub.simulateContract({ account: from, address: to, abi: withErrors(abi), functionName: fn, args, blockNumber: rc.blockNumber - 1n });
    } catch (e) {
      throw new Error(`${fn} reverted: ${errorName(e)}`);
    }
    throw new Error(`${fn} reverted`);
  }
}

export async function deployRaw(from: Address, abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<Address> {
  const hash = await wallet.deployContract({ account: from, abi, bytecode, args, chain: null, gas: 30_000_000n } as any);
  await test.mine({ blocks: 1 });
  const rc = await receipt(hash);
  if (rc.status !== "success" || !rc.contractAddress) throw new Error("a contract failed to deploy (is the node's block gas limit at least 30M?)");
  return getAddress(rc.contractAddress);
}

/** Anvil mines each transaction as it arrives; the receipt is there within a call or two. */
async function receipt(hash: Hex) {
  for (let i = 0; ; i++) {
    const rc = await pub.getTransactionReceipt({ hash }).catch(() => null);
    if (rc) return rc;
    if (i > 50) await new Promise((r) => setTimeout(r, 5));
    if (i > 5000) throw new Error(`no receipt for ${hash}`);
  }
}

export function errorName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return e.shortMessage;
  }
  return String(e);
}

// ---- the clock ----

export async function latestBlock(): Promise<{ number: bigint; timestamp: number }> {
  const b = await pub.getBlock({ blockTag: "latest" });
  return { number: b.number!, timestamp: Number(b.timestamp) };
}

/** Mines one block at `t`, or at the next second if the chain is already past it. Returns the block's time. */
export async function mineAt(t: number): Promise<{ number: bigint; timestamp: number }> {
  const last = await latestBlock();
  const at = Math.max(Math.floor(t), last.timestamp + 1);
  await test.setNextBlockTimestamp({ timestamp: BigInt(at) });
  await test.mine({ blocks: 1 });
  return { number: last.number + 1n, timestamp: at };
}

export async function fund(a: Address): Promise<void> {
  await test.setBalance({ address: a, value: 10n ** 21n });
}

export async function blockNumber(): Promise<bigint> {
  return pub.getBlockNumber({ cacheTime: 0 });
}

export async function snapshot(): Promise<Hex> {
  return test.snapshot();
}

export async function revertTo(id: Hex): Promise<void> {
  await test.revert({ id });
}

// ---- events ----

export type Decoded = {
  contract: Key; name: string; args: Record<string, any>; block: bigint; tx: Hex; index: number;
};

const NOISE = new Set(["Transfer", "Approval", "ApprovalForAll", "DirectorySynced", "RoleGranted", "RoleRevoked",
  "Initialized", "Upgraded", "AdminChanged", "BeaconUpgraded", "MetadataUpdate"]);

export async function logsBetween(from: bigint, to: bigint): Promise<Decoded[]> {
  if (to < from) return [];
  const logs: Log[] = await pub.getLogs({ fromBlock: from, toBlock: to });
  const out: Decoded[] = [];
  for (const l of logs) {
    const c = byAddress.get(l.address.toLowerCase());
    if (!c || c === "usdt") continue;
    try {
      const d = decodeEventLog({ abi: abis[c], data: l.data, topics: l.topics as any, strict: false }) as any;
      if (NOISE.has(d.eventName)) continue;
      out.push({ contract: c, name: d.eventName, args: d.args ?? {}, block: l.blockNumber!, tx: l.transactionHash!, index: l.logIndex! });
    } catch {
      // an event this app does not know: not one of the protocol's
    }
  }
  return out;
}
