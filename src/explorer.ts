// The contract explorer: every contract, function, event and error of V12, generated from the compiled contracts
// (scripts/surface.mjs), with the calls between them, who may call what, and a form to call any function live
// against the run's chain -- reads as they are, writes as any actor in the cast.
import { getAddress, isAddress, keccak256, toBytes, type Address } from "viem";
import surface from "./surface.json";
import { addr, read, send, type Key, type Decoded } from "./chain";
import { nameOf, knownActors, dateOf } from "./model";
import { kindOf, parseTyped, formatValue, hintFor, enumOf, enumNames, preview } from "./units";

export type Param = { name: string; type: string; components?: Param[]; internalType?: string };
type Fn = {
  name: string; sig: string; mutability: string; read: boolean; inputs: Param[]; outputs: Param[]; notice: string;
  details: string; params: Record<string, string>; returns: Record<string, string>; access: string; plumbing: boolean;
};
type Ev = { name: string; sig: string; inputs: (Param & { indexed?: boolean })[]; notice: string; plumbing: boolean };
type Contract = {
  key: Key; name: string; title?: string; notice?: string; dev?: string; size: number; functions: Fn[]; events: Ev[];
  errors: { name: string; sig: string }[]; calls: { to: Key; fn: string }[];
  /** An abstract base with no code of its own -- the merged build's EcoCountries -- is part of this contract. */
  partOf?: Key;
};
const S = surface as unknown as { contracts: Contract[]; roles: { name: string; doc: string }[] };
const LIMIT = 24_576;
const SHORT: Record<string, string> = {
  admin: "Admin", countries: "Countries", registry: "Registry", deeds: "Deeds", core: "Core", bank: "Bank",
  challenge: "Challenge", governance: "Governance", tree: "Tree", token: "Token", lens: "Lens", lists: "Lists",
  market: "Market", parties: "Parties", overcharge: "Overcharge", editions: "Editions",
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
// Every parameter's kind (money, a date, a duration, land, an enum...) comes from units.ts, generated from the contracts'
// integration kit: the same rules the platform guides give the frontend and backend.

/** Where a parameter sits: its contract, its function or event, and its path ("name", "struct.field"). */
export type At = { c: string; fn: string; path?: string };
const pathOf = (at: At | undefined, name: string) => (at?.path ? `${at.path}.${name}` : name);

function parseScalar(p: Param, raw: string, at?: At): unknown {
  const v = raw.trim();
  const type = p.type;
  if (type === "bool") return v === "true" || v === "1" || v === "yes";
  if (type === "address") {
    if (isAddress(v)) return getAddress(v);
    const a = knownActors().find((x) => x.name.toLowerCase() === v.toLowerCase());
    if (a) return a.address;
    throw new Error(`"${v}" is not an address or a known actor`);
  }
  if (/^u?int/.test(type)) {
    const kind = at ? kindOf(at.c, at.fn, pathOf(at, p.name), type) : undefined;
    if (kind) return BigInt(parseTyped(kind, v));
    const m = v.replace(/[_,\s]/g, "").match(/^(-?\d+(?:\.\d+)?)(?:e(\d+)|(ether|usdt|tree|tr3))?$/i);
    if (!m) throw new Error(`"${v}" is not a number (try 50, 50e18 or 50 ether)`);
    const [whole, frac = ""] = m[1].split(".");
    const exp = m[3] ? 18 : Number(m[2] ?? 0);
    if (frac.length > exp) throw new Error(`"${v}" has more decimals than the units allow`);
    return BigInt(whole + frac.padEnd(exp, "0"));
  }
  if (type === "bytes32" && v && !v.startsWith("0x")) return keccak256(toBytes(v)); // a phrase: its hash
  return v;
}

function zeroOf(p: Param): unknown {
  if (p.type.endsWith("]")) return [];
  if (p.type === "tuple") return Object.fromEntries((p.components ?? []).map((c, i) => [c.name || i, zeroOf(c)]));
  if (p.type === "bool") return false;
  if (p.type === "address") return "0x0000000000000000000000000000000000000000";
  if (/^u?int/.test(p.type)) return 0n;
  if (/^bytes\d+$/.test(p.type)) return "0x" + "00".repeat(Number(p.type.slice(5)));
  return p.type === "bytes" ? "0x" : "";
}

/** A typed field's value for the contract. `at` names where the parameter sits, so its unit applies. */
export function parseValue(p: Param, raw: unknown, at?: At): unknown {
  if (p.type.endsWith("]")) {
    const arr = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    const inner = { ...p, type: p.type.slice(0, p.type.lastIndexOf("[")) };
    return (arr as unknown[]).map((x) => parseValue(inner, x, at));
  }
  if (p.type === "tuple") {
    const obj = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
    const inner = at ? { ...at, path: pathOf(at, p.name) } : undefined;
    // a field left out is zero: in a list's filter, "any"
    return Object.fromEntries((p.components ?? []).map((c, i) => {
      const x = Array.isArray(obj) ? obj[i] : (obj as any)?.[c.name];
      return [c.name || i, x === undefined || x === null || x === "" ? zeroOf(c) : parseValue(c, x, inner)];
    }));
  }
  return parseScalar(p, String(raw), at);
}

/** A returned value or event argument for people: each in its unit, addresses with their names. */
export function showValue(v: unknown, params: Param[] | undefined, at: At, prefix: string): unknown {
  const one = (x: unknown, p: Param | undefined, path: string): unknown => {
    if (p && p.type.startsWith("tuple")) {
      const inner = (y: unknown) => (y && typeof y === "object" ? Object.fromEntries((p.components ?? []).map((c, i) => [c.name || i, one(Array.isArray(y) ? y[i] : (y as any)[c.name], c, `${path}.${c.name}`)])) : y);
      return p.type.endsWith("]") && Array.isArray(x) ? x.map(inner) : inner(x);
    }
    if (Array.isArray(x)) return x.map((y) => one(y, p ? { ...p, type: p.type.replace(/\[\d*\]$/, "") } : undefined, path));
    const kind = p ? kindOf(at.c, at.fn, path.replace(/^\./, ""), p.type) : undefined;
    if (kind && (typeof x === "bigint" || typeof x === "number")) return formatValue(kind, x);
    if (typeof x === "bigint") return x.toString();
    if (typeof x === "string" && isAddress(x)) { const n = nameOf(x); return n.startsWith("0x") ? x : `${x} (${n})`; }
    return x;
  };
  if (!params || params.length === 0) return one(v, undefined, prefix);
  if (params.length === 1) return one(v, params[0], `${prefix}${params[0].name}`);
  const arr = Array.isArray(v) ? v : params.map((p) => (v as any)?.[p.name]);
  return Object.fromEntries(params.map((p, i) => [p.name || i, one(arr[i], p, `${prefix}${p.name}`)]));
}

function show(v: unknown, outputs: Param[], at: At): string {
  const out = showValue(v, outputs, at, "returns.");
  return typeof out === "string" ? out : JSON.stringify(out, null, 2);
}

export function placeholder(p: Param, at?: At): string {
  if (p.type.endsWith("]")) return "a JSON list, e.g. [1, 2]";
  if (p.type === "tuple") return `JSON: {${(p.components ?? []).map((c) => `"${c.name}": …`).join(", ")}} (a field left out is 0, "any" in a filter; enums by name)`;
  if (p.type === "address") return "0x… or an actor's name";
  const hint = at ? hintFor(kindOf(at.c, at.fn, pathOf(at, p.name), p.type)) : undefined;
  if (hint) return hint;
  if (/^u?int/.test(p.type)) return "a number";
  if (p.type === "bytes32") return "0x… or a phrase (its hash is used)";
  return p.type;
}

/** One input field: a dropdown for an enum, else a text box with its unit's hint and a live preview. */
export function fieldHtml(p: Param, i: number, attr: string, at: At, value = ""): string {
  const kind = /^u?int/.test(p.type) && !p.type.endsWith("]") ? kindOf(at.c, at.fn, p.name, p.type) : undefined;
  const en = enumOf(kind);
  if (p.type === "bool") return `<select ${attr}="${i}"><option ${value === "false" ? "selected" : ""}>false</option><option ${value === "true" ? "selected" : ""}>true</option></select>`;
  if (en) return `<select ${attr}="${i}">${enumNames(en).map(([n, x]) => `<option value="${x}" ${String(x) === value ? "selected" : ""}>${esc(n)} (${x})</option>`).join("")}</select>`;
  if (p.type.endsWith("]") || p.type === "tuple") return `<textarea ${attr}="${i}" rows="2" placeholder="${esc(placeholder(p, at))}">${esc(value)}</textarea>`;
  const pv = kind ? preview(kind, value) : "";
  const input = `<input ${attr}="${i}" type="text" value="${esc(value)}" placeholder="${esc(placeholder(p, at))}" ${p.type === "address" ? `list="actors"` : ""} ${kind ? `data-kind="${esc(kind)}"` : ""}>`;
  // the field and what it will send, stacked in the form's second column
  return kind ? `<span class="field">${input}<small class="preview" aria-live="polite">${esc(pv)}</small></span>` : input;
}

/** Keep a field's preview in step with what is typed. */
export function wirePreviews(root: HTMLElement) {
  root.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    const kind = t.dataset?.kind;
    if (!kind) return;
    const pv = t.nextElementSibling;
    if (pv && pv.classList.contains("preview")) pv.textContent = preview(kind, t.value);
  });
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
    const W = 1000, H = 480, cx = W / 2, cy = H / 2, rx = 400, ry = 190;
    // every contract the surface lists, V12's order first; one this list does not know joins at the end
    const known: Key[] = ["admin", "countries", "registry", "deeds", "parties", "core", "bank", "market", "challenge", "governance", "tree", "editions", "token", "overcharge", "lens", "lists"];
    const order: Key[] = [...known.filter((k) => S.contracts.some((c) => c.key === k)), ...S.contracts.map((c) => c.key).filter((k) => !known.includes(k))];
    const pos = new Map(order.map((k, i) => {
      const a = (i / order.length) * Math.PI * 2 - Math.PI / 2;
      return [k, [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]] as const;
    }));
    const pairs = new Map<string, string[]>();
    for (const c of S.contracts) for (const x of c.calls) {
      const k = `${c.key}>${x.to}`;
      if (!pos.has(c.key) || !pos.has(x.to)) continue;
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
      const sub = c.partOf ? `part of ${SHORT[c.partOf] ?? c.partOf}` : `${free.toLocaleString("en-US")} B free`;
      return `<g class="node ${k === selected ? "on" : ""}" data-key="${k}" tabindex="0" role="button" aria-label="${esc(c.name)}"><rect x="${x - 78}" y="${y - 21}" width="156" height="42" rx="9"></rect><text x="${x}" y="${y - 2}" text-anchor="middle">${esc(SHORT[k] ?? c.name)}</text><text class="sub" x="${x}" y="${y + 13}" text-anchor="middle">${c.functions.filter((f) => !f.plumbing).length} fns · ${esc(sub)}</text></g>`;
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
      const field = fieldHtml(p, i, "data-arg", { c: c.key, fn: f.name });
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
    const at = { c: c.key, fn: e.name };
    const rows = last.map((x) => `<tr><td class="mono">${x.block}</td><td>${esc(Object.entries(x.args).map(([k, v]) => {
      const p = e.inputs.find((q) => q.name === k);
      const shown = showValue(v, p ? [p] : undefined, at, "");
      return `${k}: ${typeof shown === "string" ? shown : JSON.stringify(shown)}`;
    }).join(" · "))}</td></tr>`).join("");
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
        <div class="facts-inline"><span>${hooks.ready() && addr[c.key] ? `<code>${esc(addr[c.key])}</code>` : "not deployed in this session"}</span><span>${c.partOf ? `no code of its own: a base of ${esc(byKey(c.partOf)?.name ?? c.partOf)}, at its address` : `${c.size.toLocaleString("en-US")} bytes · ${(LIMIT - c.size).toLocaleString("en-US")} free of 24,576`}</span></div></header>
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
      args = f.inputs.map((p, i) => parseValue(p, (form.querySelector<HTMLInputElement>(`[data-arg="${i}"]`)!).value, { c: c.key, fn: f.name }));
    } catch (err) {
      out.textContent = `Not sent: ${(err as Error).message}`;
      return;
    }
    if (f.read) {
      out.textContent = "Reading…";
      read(c.key, f.name, args).then((v) => { out.textContent = show(v, f.outputs, { c: c.key, fn: f.name }); }, (err) => { out.textContent = `Reverted: ${(err as Error).message?.split("\n")[0]}`; });
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

  wirePreviews(root);
  render();
  return { refresh: () => { if (!root.closest("[hidden]")) { const open = [...root.querySelectorAll<HTMLDetailsElement>("details[open]")].map((d) => d.id); const y = root.querySelector("#exDetail")?.scrollTop; render(); for (const id of open) { const d = root.querySelector<HTMLDetailsElement>(`#${CSS.escape(id)}`); if (d) d.open = true; } void y; } } };
}

export { dateOf };
