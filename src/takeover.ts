// The Take over panel: what the person controls, the moves waiting for them, and acting freely as anyone.
import { isAddress, type Abi, type AbiFunction, type Address } from "viem";
import { abis, send, type Key } from "./chain";
import { nameOf, knownActors, dateOf } from "./model";
import { ROLES, ROLE_CALLS, ROLE_LABEL, roleOf, type Control, type Move } from "./control";
import { parseValue, placeholder, type Param } from "./explorer";

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const SHORT: Record<string, string> = {
  admin: "Admin", countries: "Countries", registry: "Registry", deeds: "Deeds", core: "Core", bank: "Bank", challenge: "Challenge",
  governance: "Governance", tree: "Tree", token: "Token", lens: "Lens", usdt: "USDT",
};

export type TakeoverHooks = {
  control: () => Control | undefined;
  /** Run a write between the clock's steps; its message goes to the feed. */
  enqueue: (job: () => Promise<string>) => void;
  countries: () => { code: number; name: string }[];
  requests: () => number[];
};

const fnOf = (c: Key, fn: string, n?: number) =>
  (abis[c] as Abi).find((x): x is AbiFunction => x.type === "function" && x.name === fn && (n === undefined || x.inputs.length === n));

/** A value as a person would type it back in: numbers plain, addresses by name, lists and structs as JSON. */
function asText(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && isAddress(v)) { const n = nameOf(v); return n.startsWith("0x") ? v : n; }
  if (typeof v === "object" && v !== null) return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  return String(v);
}

/** A contract's error name in plain words: NotBoundVerifier -> "not bound verifier". */
const plain = (e: string) => e.replace(/\(.*$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

function argFields(f: AbiFunction, values: unknown[] | null, prefix: string): string {
  return f.inputs.map((p, i) => {
    const v = values ? asText(values[i]) : "";
    const field = p.type === "bool"
      ? `<select data-${prefix}="${i}"><option ${v === "false" ? "selected" : ""}>false</option><option ${v === "true" ? "selected" : ""}>true</option></select>`
      : `<input data-${prefix}="${i}" type="text" value="${esc(v)}" placeholder="${esc(placeholder(p as Param))}" ${p.type === "address" ? `list="actors"` : ""}>`;
    return `<label class="arg"><span><b>${esc(p.name || `arg ${i + 1}`)}</b> <code>${esc(p.type)}</code></span>${field}</label>`;
  }).join("");
}

function readArgs(root: Element, f: AbiFunction, prefix: string): unknown[] {
  return f.inputs.map((p, i) => parseValue(p as Param, root.querySelector<HTMLInputElement>(`[data-${prefix}="${i}"]`)!.value));
}

export function mountTakeover(root: HTMLElement, hooks: TakeoverHooks) {
  let kind: "actor" | "request" | "role" | "country" = "actor";
  let freeWho = "";
  let freeFn = "";
  const errors = new Map<string, string>();
  /** What the last free call did, kept so a redraw does not lose it. */
  let freeResult = "";

  function whichOptions(): string {
    if (kind === "actor") return knownActors().map((a) => `<option value="${a.address}">${esc(a.name)} · ${esc(a.role)}</option>`).join("");
    if (kind === "role") return ROLES.map((r) => `<option value="${r}">${esc(ROLE_LABEL[r])}</option>`).join("");
    if (kind === "country") return hooks.countries().map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join("");
    return hooks.requests().slice().reverse().map((r) => `<option value="${r}">Request #${r}</option>`).join("");
  }

  function moveCard(m: Move): string {
    const f = fnOf(m.c, m.fn, m.args.length);
    const err = errors.get(m.id);
    return `<li class="move" data-move="${esc(m.id)}">
      <div class="move-head"><b>${esc(nameOf(m.who))}</b> <span class="muted small">${esc(roleOf(m.who) || "actor")}</span>
        <span class="small">${m.rid ? `request #${m.rid} · ` : ""}${dateOf(m.t)}</span></div>
      <code class="sig">${esc(SHORT[m.c] ?? m.c)}.${esc(m.fn)}</code>
      ${f ? `<div class="move-args">${argFields(f, m.args, "marg")}</div>` : ""}
      ${err ? `<p class="small err">Reverted: ${esc(plain(err))} <span class="mono">(${esc(err)})</span></p>` : ""}
      <div class="row"><button type="button" class="primary" data-do="${esc(m.id)}">Do it</button><button type="button" class="ghost" data-skip="${esc(m.id)}">Skip</button></div></li>`;
  }

  function render() {
    const c = hooks.control();
    if (!c) { root.innerHTML = `<p class="muted small">Set up a run first.</p>`; return; }
    const chips = [
      ...[...c.actors].map((a) => [`actor:${a}`, nameOf(a)]),
      ...[...c.requests].map((r) => [`request:${r}`, `Request #${r}`]),
      ...[...c.roles].map((r) => [`role:${r}`, ROLE_LABEL[r] ?? r]),
      ...[...c.countries].map((k) => [`country:${k}`, hooks.countries().find((x) => x.code === k)?.name ?? `Country ${k}`]),
    ].map(([id, label]) => `<span class="chip on">${esc(label)}<button type="button" class="x" data-drop="${esc(id)}" aria-label="Hand ${esc(label)} back">×</button></span>`).join("");
    const moves = [...c.moves.values()].sort((a, b) => a.t - b.t);
    const actors = knownActors();
    const mine = actors.filter((a) => c.actors.has(a.address));
    if (!freeWho || !actors.some((a) => a.address === freeWho)) freeWho = (mine[0] ?? actors[0])?.address ?? "";
    const calls = ROLE_CALLS[roleOf(freeWho as Address)] ?? [];
    if (!calls.some(([k, f]) => `${k}.${f}` === freeFn)) freeFn = calls[0] ? `${calls[0][0]}.${calls[0][1]}` : "";
    const [fk, fname] = freeFn.split(".") as [Key, string];
    const ff = freeFn ? fnOf(fk, fname) : undefined;
    root.innerHTML = `
      <p class="small muted">Take over any part of the run: the simulated actors stop doing it, and each step they would have taken waits here for you, with the values they would have used.</p>
      <div class="row take-add"><select id="takeKind" aria-label="What to take over">${[["actor", "An actor"], ["request", "A request"], ["role", "A role"], ["country", "A country"]]
        .map(([k, l]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${l}</option>`).join("")}</select>
        <select id="takeWhich" aria-label="Which">${whichOptions()}</select><button type="button" id="takeAdd">Take over</button></div>
      <div class="chips">${chips || `<span class="small muted">You control nothing yet: the simulation plays every part.</span>`}</div>
      <label class="check"><input type="checkbox" id="takePause" ${c.pauseOnMove ? "checked" : ""}> Pause the clock when a move is mine</label>
      <label class="check"><input type="checkbox" id="takeKeep" ${c.housekeeping ? "checked" : ""}> Hand me the housekeeping calls too (seating panels, lapsing, settling)</label>
      <h3>Your moves ${moves.length ? `<span class="badge">${moves.length}</span>` : ""}</h3>
      ${moves.length ? `<ol class="moves">${moves.map(moveCard).join("")}</ol>` : `<p class="small muted">${c.active ? "Nothing waiting for you yet." : "Take something over and its steps appear here."}</p>`}
      <h3>Act freely</h3>
      <p class="small muted">Any call the role makes, as anyone in the cast, with values you choose.</p>
      <div class="row"><select id="freeWho" aria-label="Act as">${actors.map((a) => `<option value="${a.address}" ${a.address === freeWho ? "selected" : ""}>${esc(a.name)} · ${esc(a.role)}</option>`).join("")}</select>
        <select id="freeFn" aria-label="Call">${calls.map(([k, f]) => `<option value="${k}.${f}" ${`${k}.${f}` === freeFn ? "selected" : ""}>${esc(SHORT[k] ?? k)}.${esc(f)}</option>`).join("")}</select></div>
      <form id="freeForm" class="move-args">${ff ? argFields(ff, null, "farg") : ""}<div class="row"><button type="submit" class="primary" ${ff ? "" : "disabled"}>Send</button><span class="small" id="freeOut">${esc(freeResult)}</span></div></form>`;
  }

  root.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    const c = hooks.control();
    if (!c) return;
    if (el.id === "takeKind") { kind = el.value as typeof kind; render(); }
    else if (el.id === "takePause") c.pauseOnMove = el.checked;
    else if (el.id === "takeKeep") c.housekeeping = el.checked;
    else if (el.id === "freeWho") { freeWho = el.value; freeFn = ""; freeResult = ""; render(); }
    else if (el.id === "freeFn") { freeFn = el.value; freeResult = ""; render(); }
  });

  root.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const c = hooks.control();
    if (!c) return;
    if (el.id === "takeAdd") {
      const v = (root.querySelector("#takeWhich") as HTMLSelectElement).value;
      if (!v) return;
      if (kind === "actor") c.actors.add(v as Address);
      else if (kind === "request") c.requests.add(Number(v));
      else if (kind === "role") c.roles.add(v);
      else c.countries.add(Number(v));
      render();
      return;
    }
    const drop = el.closest<HTMLElement>("[data-drop]")?.dataset.drop;
    if (drop) {
      const [k, v] = drop.split(":");
      if (k === "actor") c.actors.delete(v as Address);
      else if (k === "request") c.requests.delete(Number(v));
      else if (k === "role") c.roles.delete(v);
      else c.countries.delete(Number(v));
      // the moves no longer the person's go back to the simulation, which proposes them again when due
      for (const [id, m] of c.moves) if (!c.mine(m.who, m.rid, `${m.c}.${m.fn}`)) c.moves.delete(id);
      render();
      return;
    }
    const skip = el.closest<HTMLElement>("[data-skip]")?.dataset.skip;
    if (skip) { c.moves.delete(skip); errors.delete(skip); render(); return; }
    const id = el.closest<HTMLElement>("[data-do]")?.dataset.do;
    if (id) {
      const m = c.moves.get(id);
      const card = el.closest(".move");
      const f = m && fnOf(m.c, m.fn, m.args.length);
      if (!m || !f || !card) return;
      let args: unknown[];
      try { args = readArgs(card, f, "marg"); } catch (err) { errors.set(id, (err as Error).message); render(); return; }
      (el as HTMLButtonElement).disabled = true;
      hooks.enqueue(async () => {
        const r = await send(m.who, m.c, m.fn, args);
        if (r.ok) { c.moves.delete(id); errors.delete(id); } else errors.set(id, r.error);
        render();
        return r.ok ? `${nameOf(m.who)} called ${SHORT[m.c] ?? m.c}.${m.fn}${m.rid ? ` on #${m.rid}` : ""}.` : `${SHORT[m.c] ?? m.c}.${m.fn} as ${nameOf(m.who)} reverted: ${plain(r.error)}.`;
      });
    }
  });

  root.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const out = form.querySelector("#freeOut")!;
    const [k, fn] = freeFn.split(".") as [Key, string];
    const f = fnOf(k, fn);
    if (!f) return;
    let args: unknown[];
    try { args = readArgs(form, f, "farg"); } catch (err) { out.textContent = `Not sent: ${(err as Error).message}`; return; }
    const who = freeWho as Address;
    freeResult = "Queued: it runs between the clock's steps.";
    out.textContent = freeResult;
    hooks.enqueue(async () => {
      const r = await send(who, k, fn, args);
      freeResult = r.ok ? `Sent: ${nameOf(who)} called ${SHORT[k] ?? k}.${fn}.` : `Reverted: ${plain(r.error)} (${r.error})`;
      const o = root.querySelector("#freeOut");
      if (o) o.textContent = freeResult;
      return r.ok ? `${nameOf(who)} called ${SHORT[k] ?? k}.${fn}.` : `${SHORT[k] ?? k}.${fn} as ${nameOf(who)} reverted: ${plain(r.error)}.`;
    });
  });

  // the panel is redrawn only when what it shows changed, and never under the person's typing
  let shown = "";
  function refresh() {
    const c = hooks.control();
    const sig = c ? `${[...c.moves.keys()].join(",")}|${c.describe().join(",")}|${knownActors().length}` : "";
    if (sig === shown || root.contains(document.activeElement)) return;
    shown = sig;
    render();
  }

  render();
  return {
    render,
    refresh,
    /** Take over a request from elsewhere on the screen (its drawer). */
    takeRequest(rid: number) { const c = hooks.control(); if (c) { c.requests.add(rid); render(); } },
  };
}
