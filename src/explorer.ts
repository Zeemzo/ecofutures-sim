// The contract explorer: every contract, function, event and error of V11, generated from the compiled contracts
// (scripts/surface.mjs), with the calls between them, who may call what, and a form to call any function live
// against the run's chain -- reads as they are, writes as any actor in the cast.
import { getAddress, isAddress, keccak256, toBytes, type Address } from "viem";
import surface from "./surface.json";
import { addr, read, send, type Key, type Decoded } from "./chain";
import { nameOf, knownActors, dateOf } from "./model";

type Param = { name: string; type: string; components?: Param[]; internalType?: string };
type Fn = {
  name: string; sig: string; mutability: string; read: boolean; inputs: Param[]; outputs: Param[]; notice: string;
  details: string; params: Record<string, string>; returns: Record<string, string>; access: string; plumbing: boolean;
};
type Ev = { name: string; sig: string; inputs: (Param & { indexed?: boolean })[]; notice: string; plumbing: boolean };
type Contract = {
  key: Key; name: string; title?: string; notice?: string; dev?: string; size: number; functions: Fn[]; events: Ev[];
  errors: { name: string; sig: string }[]; calls: { to: Key; fn: string }[];
};
const S = surface as unknown as { contracts: Contract[]; roles: { name: string; doc: string }[] };
const LIMIT = 24_576;
const SHORT: Record<string, string> = {
  admin: "Admin", countries: "Countries", registry: "Registry", deeds: "Deeds", core: "Core", bank: "Bank",
  challenge: "Challenge", governance: "Governance", tree: "Tree", token: "Token", overcharge: "Overcharge", lens: "Lens",
};

export type ExplorerHooks = {
  /** The run is set up: there is a deployment to call. */
  ready: () => boolean;
  /** Every decoded event of the run so far. */
  events: () => Decoded[];
  /** Run a write between the clock's steps, and refresh the run's view after it. */
  enqueue: (job: () => Promise<string>) => void;
};

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const typeOf = (p: Param): string => p.type.startsWith("tuple") ? `(${(p.components ?? []).map(typeOf).join(", ")})${p.type.slice(5)}` : p.type;
const structName = (p: Param) => (p.internalType ?? "").replace(/^struct /, "").replace(/^contract /, "").replace(/^enum /, "");

// ---- values in and out ----

function parseScalar(type: string, raw: string): unknown {
  const v = raw.trim();
  if (type === "bool") return v === "true" || v === "1" || v === "yes";
  if (type === "address") {
    if (isAddress(v)) return getAddress(v);
    const a = knownActors().find((x) => x.name.toLowerCase() === v.toLowerCase());
    if (a) return a.address;
    throw new Error(`"${v}" is not an address or a known actor`);
  }
  if (/^u?int/.test(type)) {
    const m = v.replace(/[_,\s]/g, "").match(/^(-?\d+(?:\.\d+)?)(?:e(\d+)|(ether|usdt|tree))?$/i);
    if (!m) throw new Error(`"${v}" is not a number (try 50, 50e18 or 50 ether)`);
    const [whole, frac = ""] = m[1].split(".");
    const exp = m[3] ? 18 : Number(m[2] ?? 0);
    if (frac.length > exp) throw new Error(`"${v}" has more decimals than the units allow`);
    return BigInt(whole + frac.padEnd(exp, "0"));
  }
  if (type === "bytes32" && v && !v.startsWith("0x")) return keccak256(toBytes(v)); // a phrase: its hash
  return v;
}

function parseValue(p: Param, raw: unknown): unknown {
  if (p.type.endsWith("]")) {
    const arr = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    const inner = { ...p, type: p.type.slice(0, p.type.lastIndexOf("[")) };
    return (arr as unknown[]).map((x) => parseValue(inner, x));
  }
  if (p.type === "tuple") {
    const obj = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    return Object.fromEntries((p.components ?? []).map((c, i) => [c.name || i, parseValue(c, Array.isArray(obj) ? obj[i] : (obj as any)[c.name])]));
  }
  return parseScalar(p.type, String(raw));
}

function show(v: unknown): string {
  const fmt = (x: unknown): unknown => {
    if (typeof x === "bigint") return x >= 10n ** 15n ? `${x} (≈ ${(Number(x / 10n ** 12n) / 1e6).toLocaleString("en-US")} × 10¹⁸)` : x.toString();
    if (typeof x === "string" && isAddress(x)) { const n = nameOf(x); return n.startsWith("0x") ? x : `${x} (${n})`; }
    if (Array.isArray(x)) return x.map(fmt);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fmt(y)]));
    return x;
  };
  return JSON.stringify(fmt(v), null, 2);
}

function placeholder(p: Param): string {
  if (p.type.endsWith("]")) return "a JSON list, e.g. [1, 2]";
  if (p.type === "tuple") return `JSON: {${(p.components ?? []).map((c) => `"${c.name}": …`).join(", ")}}`;
  if (p.type === "address") return "0x… or an actor's name";
  if (/^u?int/.test(p.type)) return "a number: 50, 50e18 or 50 ether";
  if (p.type === "bytes32") return "0x… or a phrase (its hash is used)";
  return p.type;
}

// ---- the view ----

export function mountExplorer(root: HTMLElement, hooks: ExplorerHooks) {
  let selected: Key = "registry";
  let tab: "writes" | "reads" | "events" | "errors" = "writes";
  let plumbing = false;
  let query = "";

  const byKey = (k: string) => S.contracts.find((c) => c.key === k)!;
  const calledBy = (k: string) => S.contracts.filter((c) => c.calls.some((x) => x.to === k));

  function graph(): string {
    const W = 980, H = 420, cx = W / 2, cy = H / 2, rx = 390, ry = 165;
    const order: Key[] = ["admin", "countries", "registry", "deeds", "core", "bank", "challenge", "governance", "tree", "token", "overcharge", "lens"];
    const pos = new Map(order.map((k, i) => {
      const a = (i / order.length) * Math.PI * 2 - Math.PI / 2;
      return [k, [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]] as const;
    }));
    const pairs = new Map<string, string[]>();
    for (const c of S.contracts) for (const x of c.calls) {
      const k = `${c.key}>${x.to}`;
      if (!pos.has(x.to)) continue;
      pairs.set(k, [...(pairs.get(k) ?? []), x.fn]);
    }
    const edges = [...pairs.entries()].map(([k, fns]) => {
      const [a, b] = k.split(">");
      const [x1, y1] = pos.get(a as Key)!, [x2, y2] = pos.get(b as Key)!;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      const ox = (dx / len) * 62, oy = (dy / len) * 20;
      const cls = a === selected ? "out" : b === selected ? "in" : "";
      const bend = 0.12;
      const mx = (x1 + x2) / 2 - dy * bend, my = (y1 + y2) / 2 + dx * bend;
      return `<path class="edge ${cls}" d="M${x1 + ox},${y1 + oy} Q${mx},${my} ${x2 - ox},${y2 - oy}" stroke-width="${Math.min(4, 1 + fns.length / 3)}" marker-end="url(#arrow${cls ? "-" + cls : ""})"><title>${esc(SHORT[a])} calls ${esc(SHORT[b])}: ${esc([...new Set(fns)].join(", "))}</title></path>`;
    }).join("");
    const nodes = order.map((k) => {
      const [x, y] = pos.get(k)!;
      const c = byKey(k);
      const free = LIMIT - c.size;
      return `<g class="node ${k === selected ? "on" : ""}" data-key="${k}" tabindex="0" role="button" aria-label="${esc(c.name)}"><rect x="${x - 78}" y="${y - 21}" width="156" height="42" rx="9"></rect><text x="${x}" y="${y - 2}" text-anchor="middle">${esc(SHORT[k])}</text><text class="sub" x="${x}" y="${y + 13}" text-anchor="middle">${c.functions.filter((f) => !f.plumbing).length} fns · ${free.toLocaleString("en-US")} B free</text></g>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="The contracts and the calls between them">
      <defs>${["", "-out", "-in"].map((s) => `<marker id="arrow${s}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead${s}"></path></marker>`).join("")}</defs>
      ${edges}${nodes}</svg>`;
  }

  function fnCard(c: Contract, f: Fn): string {
    const id = `${c.key}-${f.sig}`.replace(/[^\w-]/g, "_");
    const params = f.inputs.map((p, i) => {
      const nm = p.name || `arg${i}`;
      const doc = f.params[p.name] ?? "";
      const field = p.type === "bool"
        ? `<select data-arg="${i}"><option>false</option><option>true</option></select>`
        : p.type.endsWith("]") || p.type === "tuple"
          ? `<textarea data-arg="${i}" rows="2" placeholder="${esc(placeholder(p))}"></textarea>`
          : `<input data-arg="${i}" type="text" placeholder="${esc(placeholder(p))}" ${p.type === "address" ? `list="actors"` : ""}>`;
      return `<label class="arg"><span><b>${esc(nm)}</b> <code>${esc(typeOf(p))}</code>${structName(p) && p.type.startsWith("tuple") ? ` <small>${esc(structName(p))}</small>` : ""}${doc ? `<small>${esc(doc)}</small>` : ""}</span>${field}</label>`;
    }).join("");
    const outs = f.outputs.length ? `<p class="small muted">Returns ${f.outputs.map((o) => `<code>${esc(typeOf(o))}${o.name ? " " + esc(o.name) : ""}</code>`).join(", ")}</p>` : "";
    const actors = f.read ? "" : `<label class="arg"><span><b>Send as</b><small>Anyone can be impersonated on the local chain; the contract decides whether they may.</small></span><select data-from>${knownActors().map((a) => `<option value="${a.address}">${esc(a.name)} · ${esc(a.role)}</option>`).join("")}</select></label>`;
    return `<details class="fn" id="${id}" data-fn="${esc(f.sig)}">
      <summary><code class="nm">${esc(f.name)}</code><span class="acc">${esc(f.access)}</span><span class="mut ${f.read ? "r" : "w"}">${f.read ? "read" : f.mutability === "payable" ? "payable" : "write"}</span></summary>
      <div class="fn-body"><code class="sig">${esc(c.name)}.${esc(f.sig)}</code>
        ${f.notice ? `<p>${esc(f.notice)}</p>` : ""}${f.details ? `<p class="small muted">${esc(f.details)}</p>` : ""}${outs}
        <form class="try" data-key="${c.key}" data-sig="${esc(f.sig)}">${params}${actors}
          <div class="row"><button type="submit" class="${f.read ? "" : "primary"}">${f.read ? "Read" : "Send"}</button><span class="small muted">${hooks.ready() ? `at ${esc(addr[c.key] ?? "")}` : "Set up a run first: there is no deployment to call yet."}</span></div>
          <pre class="out" hidden></pre></form></div></details>`;
  }

  function eventCard(c: Contract, e: Ev): string {
    const seen = hooks.events().filter((x) => x.contract === c.key && x.name === e.name);
    const last = seen.slice(-6).reverse();
    const rows = last.map((x) => `<tr><td class="mono">${x.block}</td><td>${esc(Object.entries(x.args).map(([k, v]) => `${k}: ${typeof v === "bigint" ? v.toString() : typeof v === "string" && isAddress(v) ? nameOf(v) : typeof v === "object" ? JSON.stringify(v, (_, y) => typeof y === "bigint" ? y.toString() : y) : String(v)}`).join(" · "))}</td></tr>`).join("");
    return `<details class="fn"><summary><code class="nm">${esc(e.name)}</code><span class="acc">${seen.length.toLocaleString("en-US")} in this run</span><span class="mut e">event</span></summary>
      <div class="fn-body"><code class="sig">${esc(e.sig)}</code>${e.notice ? `<p>${esc(e.notice)}</p>` : ""}
      <p class="small muted">${e.inputs.map((p) => `<code>${esc(typeOf(p))} ${esc(p.name)}</code>${p.indexed ? " <small>indexed</small>" : ""}`).join(", ")}</p>
      ${rows ? `<div class="table"><table><thead><tr><th>Block</th><th>The latest, newest first</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="small muted">Not emitted in this run yet.</p>`}</div></details>`;
  }

  function detail(): string {
    const c = byKey(selected);
    const keep = <T extends { plumbing?: boolean }>(xs: T[]) => xs.filter((x) => plumbing || !x.plumbing);
    const writes = keep(c.functions.filter((f) => !f.read)), reads = keep(c.functions.filter((f) => f.read)), events = keep(c.events);
    const to = [...new Set(c.calls.map((x) => x.to))].filter((k) => SHORT[k]);
    const from = calledBy(c.key).map((x) => x.key);
    const chip = (k: string) => `<button type="button" class="chip" data-goto="${k}">${esc(SHORT[k])}</button>`;
    const list = tab === "writes" ? writes.map((f) => fnCard(c, f)).join("") : tab === "reads" ? reads.map((f) => fnCard(c, f)).join("")
      : tab === "events" ? events.map((e) => eventCard(c, e)).join("") : `<ul class="errs-list">${c.errors.map((e) => `<li><code>${esc(e.sig)}</code></li>`).join("")}</ul>`;
    return `<header class="ex-head"><div><span class="eyebrow">${esc(c.name)}</span><h2>${esc((c.title ?? c.name).replace(/^\w+ -- /, ""))}</h2></div>
        <div class="facts-inline"><span>${hooks.ready() && addr[c.key] ? `<code>${esc(addr[c.key])}</code>` : "not deployed in this session"}</span><span>${c.size.toLocaleString("en-US")} bytes · ${(LIMIT - c.size).toLocaleString("en-US")} free of 24,576</span></div></header>
      ${c.notice ? `<p class="lead">${esc(c.notice)}</p>` : ""}${c.dev ? `<p class="small muted">${esc(c.dev)}</p>` : ""}
      <div class="links"><span>Calls</span>${to.map(chip).join("") || "<em>nothing</em>"}<span>Called by</span>${from.map(chip).join("") || "<em>no contract</em>"}</div>
      <div class="tabs ex-tabs" role="tablist">${([["writes", `Writes (${writes.length})`], ["reads", `Reads (${reads.length})`], ["events", `Events (${events.length})`], ["errors", `Errors (${c.errors.length})`]] as const).map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === tab}" data-extab="${k}">${l}</button>`).join("")}
        <label class="check"><input type="checkbox" id="plumbing" ${plumbing ? "checked" : ""}> Show plumbing (initialize, sync, pause…)</label></div>
      <div class="fns">${list}</div>`;
  }

  function sidebar(): string {
    const q = query.trim().toLowerCase();
    if (q) {
      const hits: string[] = [];
      for (const c of S.contracts) {
        for (const f of c.functions) if (f.name.toLowerCase().includes(q) || f.notice.toLowerCase().includes(q)) hits.push(`<button type="button" class="hit" data-goto="${c.key}" data-tab="${f.read ? "reads" : "writes"}" data-open="${esc(c.key + "-" + f.sig)}"><b>${esc(SHORT[c.key])}.${esc(f.name)}</b><small>${esc(f.read ? "read" : "write")} · ${esc(f.access)}</small></button>`);
        for (const e of c.events) if (e.name.toLowerCase().includes(q)) hits.push(`<button type="button" class="hit" data-goto="${c.key}" data-tab="events"><b>${esc(SHORT[c.key])}.${esc(e.name)}</b><small>event</small></button>`);
        for (const e of c.errors) if (e.name.toLowerCase().includes(q)) hits.push(`<button type="button" class="hit" data-goto="${c.key}" data-tab="errors"><b>${esc(SHORT[c.key])}.${esc(e.name)}</b><small>error</small></button>`);
      }
      return `<p class="small muted">${hits.length} matches</p>${hits.slice(0, 200).join("")}`;
    }
    const cs = S.contracts.map((c) => `<button type="button" class="side-c ${c.key === selected ? "on" : ""}" data-goto="${c.key}"><b>${esc(c.name)}</b><small>${esc((c.title ?? "").replace(/^\w+ -- /, ""))}</small></button>`).join("");
    const rs = S.roles.map((r) => `<li><b>${esc(r.name)}</b>${r.doc ? ` <span class="muted">${esc(r.doc)}</span>` : ""}</li>`).join("");
    const total = S.contracts.reduce((a, c) => a + c.functions.length, 0), evs = S.contracts.reduce((a, c) => a + c.events.length, 0);
    return `<h3>Contracts</h3><p class="small muted">${S.contracts.length} contracts · ${total} functions · ${evs} events, from the compiled build.</p>${cs}<h3>Roles</h3><ul class="roles">${rs}</ul>
      <p class="small muted">GTAs are not a role: they are seats in Governance. A panel seat is drawn per challenge.</p>`;
  }

  function render() {
    root.innerHTML = `<div class="ex">
      <aside class="ex-side panel"><input id="exSearch" type="search" placeholder="Search functions, events, errors" value="${esc(query)}" aria-label="Search the contracts"><div id="exSide">${sidebar()}</div></aside>
      <div class="ex-main"><section class="panel ex-graph">${graph()}<p class="small muted">Arrows are calls from one contract to another, read from the source; thicker means more functions. The selected contract's calls are green, the calls into it amber.</p></section>
      <section class="panel ex-detail" id="exDetail">${detail()}</section></div></div>
      <datalist id="actors">${knownActors().map((a) => `<option value="${esc(a.name)}">${esc(a.role)}</option>`).join("")}</datalist>`;
  }

  function go(key: string, t?: string, open?: string) {
    selected = key as Key;
    if (t) tab = t as typeof tab;
    render();
    if (open) {
      const el = root.querySelector<HTMLDetailsElement>(`#${CSS.escape(open.replace(/[^\w-]/g, "_"))}`);
      if (el) { el.open = true; el.scrollIntoView({ block: "center" }); }
    }
  }

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const g = t.closest<HTMLElement>("[data-goto]");
    if (g) { go(g.dataset.goto!, g.dataset.tab, g.dataset.open); return; }
    const n = t.closest<SVGGElement>(".node");
    if (n) { go(n.dataset.key!); return; }
    const x = t.closest<HTMLElement>("[data-extab]");
    if (x) { tab = x.dataset.extab as typeof tab; render(); }
  });
  root.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === "plumbing") { plumbing = t.checked; render(); }
  });
  root.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === "exSearch") { query = t.value; root.querySelector("#exSide")!.innerHTML = sidebar(); }
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const out = form.querySelector<HTMLPreElement>(".out")!;
    out.hidden = false;
    if (!hooks.ready()) { out.textContent = "Set up a run first: there is no deployment to call yet."; return; }
    const c = byKey(form.dataset.key!);
    const f = c.functions.find((x) => x.sig === form.dataset.sig)!;
    let args: unknown[];
    try {
      args = f.inputs.map((p, i) => parseValue(p, (form.querySelector<HTMLInputElement>(`[data-arg="${i}"]`)!).value));
    } catch (err) {
      out.textContent = `Not sent: ${(err as Error).message}`;
      return;
    }
    if (f.read) {
      out.textContent = "Reading…";
      read(c.key, f.name, args).then((v) => { out.textContent = show(v); }, (err) => { out.textContent = `Reverted: ${(err as Error).message?.split("\n")[0]}`; });
      return;
    }
    const from = (form.querySelector<HTMLSelectElement>("[data-from]")!).value as Address;
    out.textContent = `Queued: ${nameOf(from)} calls ${c.name}.${f.name}. It runs between the clock's steps.`;
    hooks.enqueue(async () => {
      const r = await send(from, c.key, f.name, args);
      out.textContent = r.ok ? `Sent. Transaction ${r.hash}` : `Reverted: ${r.error}`;
      return r.ok ? `${nameOf(from)} called ${SHORT[c.key]}.${f.name}.` : `${SHORT[c.key]}.${f.name} as ${nameOf(from)} reverted: ${r.error}.`;
    });
  });

  render();
  return { refresh: () => { if (!root.closest("[hidden]")) { const open = [...root.querySelectorAll<HTMLDetailsElement>("details[open]")].map((d) => d.id); const y = root.querySelector("#exDetail")?.scrollTop; render(); for (const id of open) { const d = root.querySelector<HTMLDetailsElement>(`#${CSS.escape(id)}`); if (d) d.open = true; } void y; } } };
}

export { dateOf };
