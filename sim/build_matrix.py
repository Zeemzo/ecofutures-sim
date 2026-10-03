#!/usr/bin/env python3
"""Builds sim/report/matrix.html from the configuration matrix in sim/out/matrix/<name>/ (simulator/scripts/matrix.ts)."""
import json, html, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
E = html.escape
DAY = 86400
cases = []
for d in sorted((ROOT / "out" / "matrix").iterdir()):
    if not (d / "audit.json").exists():
        continue
    cfg = json.load(open(d / "config.json"))
    cases.append({"name": d.name, "cfg": cfg, "audit": json.load(open(d / "audit.json"))})
ORDER = ["one", "fifteen", "fill", "challenges", "holder-failure", "late", "pathb", "edition-race", "breaches", "fast-clock", "slow-clock", "fees", "new-countries", "lean-cast"]
cases.sort(key=lambda c: ORDER.index(c["name"]) if c["name"] in ORDER else 99)

check_ids = []
for c in cases:
    for k in c["audit"]["checks"]:
        if k["id"] not in check_ids:
            check_ids.append(k["id"])
meta = {}
for c in cases:
    for k in c["audit"]["checks"]:
        meta.setdefault(k["id"], k)
areas = {}
for cid in check_ids:
    areas.setdefault(meta[cid]["area"], []).append(cid)

total_checks = sum(k["checked"] for c in cases for k in c["audit"]["checks"])
total_fail = sum(k["failureCount"] for c in cases for k in c["audit"]["checks"])
total_tx = sum(c["audit"]["transactions"] for c in cases)
total_req = sum(c["audit"]["counts"]["VerificationRequested"] for c in cases)


def settings(c):
    k = c["cfg"]["scenario"]["contracts"]
    cs = c["cfg"]["scenario"]["countries"]
    b = c["cfg"]["scenario"]["behaviour"]
    return (f"year {k['yearDays']} d · review {k['reviewDays']} d · watchdog {k['watchdogDays']} d · challenge {k['responseDays']}+{k['panelDays']}+{k['redrawDays']} d · "
            f"halt after {k['haltAfter']} · V {k['baseFee']} · split {k['verifierPermille']}/{k['taxPermille']}/{k['serverPermille']}‰ · editions ÷{round(1_000_000 / k['editionScale']):,} · "
            f"{', '.join(x['short'] + ' ' + str(x['code']) for x in cs)} · {b['arrivalsPerYear']:g} landowners a year")


def cell(c, cid):
    k = next((x for x in c["audit"]["checks"] if x["id"] == cid), None)
    if k is None:
        return '<td class="na">—</td>'
    if k["checked"] == 0:
        return '<td class="na" title="Nothing of this kind happened in this run">·</td>'
    if k["failureCount"] == 0:
        return f'<td class="ok" title="{k["checked"]:,} checked">{k["checked"]:,}</td>'
    return f'<td class="bad" title="{E(k["failures"][0]["detail"])}">{k["failureCount"]} of {k["checked"]:,}</td>'


head = "".join(f'<th class="rot" title="{E(meta[cid]["rule"])}"><span>{E(cid)}</span></th>' for cid in check_ids)
rows = []
for c in cases:
    a = c["audit"]
    rows.append(f'<tr><th class="nm"><b>{E(c["cfg"]["scenario"]["name"])}</b><small>{a["counts"]["VerificationRequested"]} requests · {a["transactions"]:,} tx</small></th>'
                + "".join(cell(c, cid) for cid in check_ids) + "</tr>")
cards = []
for c in cases:
    a = c["audit"]
    cnt = a["counts"]
    cards.append(f'''<article class="case"><h3>{E(c["cfg"]["scenario"]["name"])}</h3><p>{E(c["cfg"].get("what") or c["cfg"]["scenario"].get("summary", ""))}</p>
      <p class="mono small">{E(settings(c))}</p>
      <p class="small muted">{cnt["VerificationRequested"]} requests · {cnt["Activated"]} activated · {cnt["CovenantVerified"]:,} re-verifications · {cnt["ChallengeRaised"]} challenges · {cnt["VerifierReplaced"]} reseats · {cnt["SaleLapsed"]} path B lapses · {a["observations"]["halts"]} halts · {a["transactions"]:,} transactions, {a["unexpectedFailed"]} unexpected failures</p></article>''')

rules = []
for area, ids in areas.items():
    rules.append(f'<h3>{E(area)}</h3><ul class="rules">' + "".join(f'<li><code>{E(i)}</code> {E(meta[i]["rule"])} <small>{E(meta[i]["source"])}</small></li>' for i in ids) + "</ul>")

page = f"""<title>V11 Configuration Matrix</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root {{ --ground:#eef2ef; --surface:#fff; --surface-2:#f5f7f5; --line:#d5ddd8; --ink:#15211c; --muted:#5a6a63; --faint:#8a9a92; --moss:#2d7a57; --moss-soft:#d9ece2; --rust:#b0412c; --rust-soft:#f6dcd5;
  --display:"IBM Plex Sans Condensed","Arial Narrow",Arial,sans-serif; --body:"IBM Plex Sans","Helvetica Neue",Arial,sans-serif; --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ color-scheme:dark; --ground:#0e1512; --surface:#151f1a; --surface-2:#1a2620; --line:#2a3a32; --ink:#e2ebe6; --muted:#9fb2a8; --faint:#6e8178; --moss:#4fb487; --moss-soft:#1d3a2d; --rust:#e0735c; --rust-soft:#3d2019; }} }}
:root[data-theme="dark"] {{ color-scheme:dark; --ground:#0e1512; --surface:#151f1a; --surface-2:#1a2620; --line:#2a3a32; --ink:#e2ebe6; --muted:#9fb2a8; --faint:#6e8178; --moss:#4fb487; --moss-soft:#1d3a2d; --rust:#e0735c; --rust-soft:#3d2019; }}
* {{ box-sizing:border-box; }}
body {{ background:var(--ground); color:var(--ink); font:15px/1.6 var(--body); margin:0; padding:0 16px; }}
.wrap {{ max-width:1240px; margin:0 auto; padding-block:30px 70px; display:grid; gap:32px; }}
h1,h2,h3 {{ font-family:var(--display); margin:0; text-wrap:balance; }}
h1 {{ font-size:clamp(28px,4vw,42px); line-height:1.05; }} h2 {{ font-size:23px; }} h3 {{ font-size:17px; }}
p {{ margin:0; max-width:80ch; }}
.eyebrow {{ font:600 12px/1 var(--display); letter-spacing:.12em; text-transform:uppercase; color:var(--moss); }}
.muted {{ color:var(--muted); }} .small {{ font-size:13px; }} .mono {{ font-family:var(--mono); font-size:12px; }}
section {{ display:grid; gap:14px; }}
header.top {{ display:grid; gap:12px; padding-bottom:20px; border-bottom:1px solid var(--line); }}
.stats {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }}
@media (max-width:760px) {{ .stats {{ grid-template-columns:repeat(2,minmax(0,1fr)); }} }}
.stat {{ background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; display:grid; gap:4px; }}
.stat b {{ font:500 26px/1.1 var(--mono); }} .stat span {{ font-size:13px; color:var(--muted); }}
.card {{ background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }}
.scroll {{ overflow-x:auto; }}
table {{ border-collapse:collapse; font-size:12.5px; }}
th.rot {{ height:170px; vertical-align:bottom; padding:0 2px 8px; white-space:nowrap; }}
th.rot span {{ writing-mode:vertical-rl; transform:rotate(180deg); font:500 11.5px var(--mono); color:var(--muted); }}
th.nm {{ text-align:left; padding:8px 12px 8px 0; white-space:nowrap; font-weight:400; }}
th.nm b {{ display:block; font:600 13px var(--body); }} th.nm small {{ color:var(--muted); font-size:11.5px; }}
td {{ text-align:center; padding:6px 4px; border:1px solid var(--line); font:500 11px var(--mono); min-width:38px; }}
td.ok {{ background:var(--moss-soft); color:var(--moss); }} td.bad {{ background:var(--rust-soft); color:var(--rust); font-weight:700; }} td.na {{ color:var(--faint); }}
.cases {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }}
@media (max-width:860px) {{ .cases {{ grid-template-columns:1fr; }} }}
.case {{ background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; display:grid; gap:6px; }}
.rules {{ margin:6px 0 14px; padding-left:18px; display:grid; gap:5px; font-size:13.5px; }}
.rules small {{ display:block; color:var(--muted); font-size:12px; }}
.rules code {{ font:500 12px var(--mono); color:var(--moss); }}
.fixed {{ display:grid; gap:10px; }}
.fixed article {{ background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--moss); border-radius:8px; padding:12px 16px; display:grid; gap:4px; font-size:14px; }}
pre {{ background:var(--surface-2); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; font:13px/1.6 var(--mono); margin:0; }}
</style>
<div class="wrap">
<header class="top"><span class="eyebrow">EcoFutures V11 · every configuration, checked against the contracts</span>
  <h1>Each configuration the simulator offers, run on the real contracts and audited from the chain</h1>
  <p class="muted">Every scenario, plus runs that move the clock, the fees and the countries far from production. For each: a fresh chain, V11 deployed with that configuration, the run, and an audit that reads the configuration back from the contracts and checks every event against it.</p></header>

<section><div class="stats">
  <div class="stat"><b>{len(cases)}</b><span>configurations</span></div>
  <div class="stat"><b>{total_checks:,}</b><span>individual checks</span></div>
  <div class="stat"><b>{total_fail}</b><span>failures</span></div>
  <div class="stat"><b>{total_tx:,}</b><span>transactions, {total_req:,} requests</span></div></div>
  <p>{"<b>Every check held in every configuration.</b> The contracts enforced exactly what each configuration set: each timing, fee, fee split, edition scale, flow, term range, listing and post-sale window, and cast; and every unit of money balanced." if total_fail == 0 else f"<b>{total_fail} checks failed;</b> see the matrix."}</p></section>

<section><h2>The matrix</h2><p class="muted small">Each cell counts the cases checked; hover a column for its rule. Green held; red failed; a dot means nothing of that kind happened in that run.</p>
  <div class="card scroll"><table><thead><tr><th></th>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div></section>

<section><h2>The configurations</h2><div class="cases">{"".join(cards)}</div></section>

<section><h2>What was wrong, and is fixed</h2><p class="muted">Raised by the first pass of the matrix. None was a contract defect.</p><div class="fixed">
  <article><b>The simulator's governance calendar, with one Trust Admin a country.</b><span class="muted">It removed the Trust Admin it had just admitted, then named that one its own successor; the contract refused, correctly (<code>InvalidSuccessor</code>). The calendar now removes one of the country's own.</span></article>
  <article><b>The simulator, after a revocation it expected to freeze.</b><span class="muted">An unauthorised revocation freezes the Trust Admin only while it is active; this one had been removed a week before, so nothing was frozen, and the later unfreeze was refused (<code>NotFrozen</code>). The simulator now unfreezes only what was frozen.</span></article>
  <article><b>Four audit rules that were too narrow.</b><span class="muted">A finished flow reports its end as step 0; a lapsed sale can sell again, so a lapse belongs to the sale before it; a late verification covers every interval begun since (<code>test_LateVerificationCatchesUp</code>); and a payee switch pays the outgoing guardian its TR3 before the patron's next claim. Each rule now matches the contract.</span></article>
</div></section>

<section><h2>The rules</h2><div class="card">{"".join(rules)}</div></section>

<section><h2>Running it again</h2><pre>cd v11/simulator
npx tsx scripts/matrix.ts              # every configuration, four at a time, each on its own fresh chain
npx tsx scripts/matrix.ts fees late    # just these
python3 ../sim/build_matrix.py         # this page</pre>
  <p class="muted small">Any configuration saved from the setup screen runs the same way: <code>RPC=… CONFIG=file.json npx tsx scripts/headless.ts</code>, then <code>CONFIG=file.json npx tsx scripts/audit.ts</code>.</p></section>
</div>
"""
out = ROOT / "report" / "matrix.html"
out.write_text(page)
print(out, len(page) // 1024, "KB", len(cases), "configurations", total_fail, "failures")
