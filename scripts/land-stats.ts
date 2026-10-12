// After a run: each country's plot sizes and sale prices, from the chain alone -- to check the Countries tab's
// typical and largest plots and value per hectare-year against what the run produced.
//   RPC=http://127.0.0.1:8545 npx tsx scripts/land-stats.ts
import { getContractAddress, zeroAddress, parseAbiItem } from "viem";
import { loadDeployment, abis, bulk, addr } from "../src/chain";
const adminAddr = getContractAddress({ from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", nonce: 3n });
const dir = await bulk.readContract({ address: adminAddr, abi: abis.admin, functionName: "directory" }) as any;
await loadDeployment({ ...dir, usdt: zeroAddress, lens: zeroAddress, forwarder: zeroAddress, editionScale: 0, deployedAt: 0 });
const rd = (k: any, fn: string, args: any[] = []) => bulk.readContract({ address: (addr as any)[k], abi: (abis as any)[k], functionName: fn, args }) as Promise<any>;
const n = Number(await rd("registry", "nextRequestId"));
const by: Record<number, { ha: number[]; perHaYr: number[]; price: number[] }> = {};
const reqs: any[] = [];
for (let i = 1; i < n; i++) { const r = await rd("registry", "getRequest", [BigInt(i)]); reqs[i] = r; (by[Number(r.country)] ??= { ha: [], perHaYr: [], price: [] }).ha.push(Number(r.landUnits) / 100); }
const logs = await bulk.getLogs({ address: (addr as any).market, event: parseAbiItem("event SaleCompleted(uint256 indexed tokenId, address indexed buyer, uint256 price, bool active)"), fromBlock: 0n, toBlock: "latest" });
for (const l of logs) {
  const c = await rd("core", "getCovenant", [l.args.tokenId]); const r = reqs[Number(c.requestId)];
  const ha = Number(r.landUnits) / 100, price = Number(l.args.price) / 1e18;
  by[Number(r.country)].price.push(price); by[Number(r.country)].perHaYr.push(price / ha / Number(r.termYears));
}
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 1 });
const name: Record<string, string> = { "144": "Sri Lanka", "360": "Indonesia", "392": "Japan", "76": "Brazil" };
for (const [c, v] of Object.entries(by)) console.log(`${name[c] ?? `country ${c}`}: ${v.ha.length} lands; ha median ${f(q(v.ha, .5))}, p90 ${f(q(v.ha, .9))}, max ${f(Math.max(...v.ha))}; ${v.price.length} sales, price median ${f(q(v.price, .5))} USDT, per ha-yr median ${f(q(v.perHaYr, .5))} (p10 ${f(q(v.perHaYr, .1))}, p90 ${f(q(v.perHaYr, .9))})`);
