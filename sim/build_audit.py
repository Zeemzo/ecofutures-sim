#!/usr/bin/env python3
"""Builds sim/report/audit.html from the chain audits in sim/out/audit-*/audit.json (simulator/scripts/audit.ts)."""
import json, html, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
RUNS = [("full", "A whole programme, to its end", "Thresholds ÷500, 40 landowners a year, seed 5"),
        ("live", "Your live run, year 19", "Thresholds ÷50, 20 landowners a year, copied at block 20,635")]
runs = {k: json.load(open(ROOT / "out" / f"audit-{k}" / "audit.json")) for k, _, _ in RUNS}
E = html.escape
fmt = lambda n: f"{n:,}"
date = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%-d %b %Y")

# Failures the investigation explained, by run and check id.
EXPLAINED = {
    ("full", "instalment-split"): "F1", ("live", "instalment-split"): "F1",
    ("live", "sale-conservation"): "copy", ("live", "pool-conservation"): "copy",
}

def check_rows():
    ids = [c["id"] for c in runs["full"]["checks"]]
    out = []
    for cid in ids:
        cs = {k: next(c for c in runs[k]["checks"] if c["id"] == cid) for k in runs}
        c0 = cs["full"]
        cells = []
        status = "pass"
        for k in ("full", "live"):
            c = cs[k]
            f = c["failureCount"]
            if f == 0:
                cells.append(f'<td class="num">{fmt(c["checked"])}</td><td class="num ok">0</td>')
            else:
                why = EXPLAINED.get((k, cid))
                tag = {"F1": "finding F1", "copy": "copy artefact"}.get(why, "unexplained")
                if why == "F1": status = "finding"
                elif why == "copy" and status == "pass": status = "cleared"
                else: status = "fail"
                cells.append(f'<td class="num">{fmt(c["checked"])}</td><td class="num bad">{f} <small>{tag}</small></td>')
        pill = {"pass": ("held", "p-ok"), "finding": ("finding F1", "p-find"), "cleared": ("cleared", "p-clear"), "fail": ("failed", "p-bad")}[status]
        out.append(f'<tr><td>{E(c0["area"])}</td><td>{E(c0["rule"])}<small>{E(c0["source"])}</small></td>{"".join(cells)}<td><span class="pill {pill[1]}">{pill[0]}</span></td></tr>')
    return "\n".join(out)

def run_cards():
    out = []
    for k, title, sub in RUNS:
        a = runs[k]; c = a["counts"]; o = a["observations"]
        rows = [
            ("Programme time", f'{date(a["from"])} to {date(a["to"])}'),
            ("Transactions", fmt(a["transactions"])), ("Protocol events", fmt(a["events"])),
            ("Requests", fmt(c["VerificationRequested"])), ("Covenants activated", fmt(c["Activated"])),
            ("Re-verifications", fmt(c["CovenantVerified"])), ("Instalment payments", fmt(c["InstalmentsReleased"])),
            ("Challenges raised", fmt(c["ChallengeRaised"])),
            ("…decided, lapsed, withdrawn", f'{c["ChallengeDetermined"]}, {c["ChallengeLapsed"]}, {c["ChallengeWithdrawn"]}'),
            ("Seats vacated, reseats", f'{c["SeatVacated"]}, {c["VerifierReplaced"]}'),
            ("Breaches held and cured", f'{c["BreachHeld"]} / {c["BreachCured"]}'),
            ("Blocks, cancellations", f'{c["CovenantBlocked"]}, {c["CovenantCancelled"]}'),
            ("Path B sales lapsed", fmt(c["SaleLapsed"])), ("Resales, overcharges", f'{c["Sold"]}, {c["Overcharged"]}'),
            ("TR3 claims", fmt(c["RewardClaimed"])), ("Council decisions executed", fmt(c["ProposalExecuted"])),
            ("Release halts (3 unattested windows)", fmt(o["halts"])),
            ("Failed transactions", f'{a["failed"]} ({a["unexpectedFailed"]} unexpected)'),
        ]
        body = "".join(f"<div><dt>{E(r[0])}</dt><dd>{E(r[1])}</dd></div>" for r in rows)
        out.append(f'<section class="card run"><span class="eyebrow">{E(sub)}</span><h3>{E(title)}</h3><dl class="facts">{body}</dl></section>')
    return "\n".join(out)

f, l = runs["full"]["observations"], runs["live"]["observations"]
total_checked = sum(c["checked"] for k in runs for c in runs[k]["checks"])
n_checks = len(runs["full"]["checks"])

page = f"""<title>V11 Chain Audit</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root {{ --ground:#eef2ef; --surface:#fff; --surface-2:#f5f7f5; --line:#d5ddd8; --ink:#15211c; --muted:#5a6a63; --faint:#8a9a92;
  --moss:#2d7a57; --moss-soft:#d9ece2; --amber:#a46c16; --amber-soft:#f5e8cf; --rust:#b0412c; --rust-soft:#f6dcd5; --slate:#5f6f86; --slate-soft:#e3e8f0;
  --display:"IBM Plex Sans Condensed","Arial Narrow",Arial,sans-serif; --body:"IBM Plex Sans","Helvetica Neue",Arial,sans-serif; --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ color-scheme:dark; --ground:#0e1512; --surface:#151f1a; --surface-2:#1a2620; --line:#2a3a32; --ink:#e2ebe6; --muted:#9fb2a8; --faint:#6e8178;
  --moss:#4fb487; --moss-soft:#1d3a2d; --amber:#d9a24a; --amber-soft:#3a2e17; --rust:#e0735c; --rust-soft:#3d2019; --slate:#93a3bb; --slate-soft:#232c38; }} }}
:root[data-theme="dark"] {{ color-scheme:dark; --ground:#0e1512; --surface:#151f1a; --surface-2:#1a2620; --line:#2a3a32; --ink:#e2ebe6; --muted:#9fb2a8; --faint:#6e8178;
  --moss:#4fb487; --moss-soft:#1d3a2d; --amber:#d9a24a; --amber-soft:#3a2e17; --rust:#e0735c; --rust-soft:#3d2019; --slate:#93a3bb; --slate-soft:#232c38; }}
* {{ box-sizing:border-box; }}
body {{ background:var(--ground); color:var(--ink); font:15px/1.6 var(--body); margin:0; padding:0 16px; }}
.wrap {{ max-width:1120px; margin:0 auto; padding-block:30px 70px; display:grid; gap:34px; }}
h1,h2,h3 {{ font-family:var(--display); margin:0; text-wrap:balance; }}
h1 {{ font-size:clamp(30px,4.2vw,44px); line-height:1.05; }}
h2 {{ font-size:24px; }} h3 {{ font-size:18px; }}
p {{ margin:0; max-width:74ch; }}
.eyebrow {{ font:600 12px/1 var(--display); letter-spacing:.12em; text-transform:uppercase; color:var(--moss); }}
.muted {{ color:var(--muted); }}
.mono {{ font-family:var(--mono); font-size:.92em; }}
section {{ display:grid; gap:14px; }}
header.top {{ display:grid; gap:14px; padding-bottom:22px; border-bottom:1px solid var(--line); }}
.lede {{ font-size:17px; color:var(--muted); }}
.card {{ background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:18px 20px; }}
.verdict {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }}
@media (max-width:760px) {{ .verdict {{ grid-template-columns:repeat(2,minmax(0,1fr)); }} }}
.stat {{ background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; display:grid; gap:4px; }}
.stat b {{ font:500 26px/1.1 var(--mono); font-variant-numeric:tabular-nums; }}
.stat span {{ font-size:13px; color:var(--muted); }}
.stat.warn b {{ color:var(--amber); }}
.finding {{ display:grid; gap:10px; background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:20px 22px; }}
.finding header {{ display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }}
.finding .id {{ font:600 13px var(--mono); color:var(--muted); }}
.finding dl {{ display:grid; grid-template-columns:150px 1fr; gap:8px 16px; margin:4px 0 0; }}
@media (max-width:640px) {{ .finding dl {{ grid-template-columns:1fr; }} }}
.finding dt {{ font:600 12px var(--display); letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding-top:2px; }}
.finding dd {{ margin:0; }}
blockquote {{ margin:0; padding:8px 14px; border-left:3px solid var(--moss); background:var(--surface-2); border-radius:0 6px 6px 0; font-style:italic; }}
.pill {{ display:inline-block; font:600 11px/1 var(--display); letter-spacing:.06em; text-transform:uppercase; padding:5px 8px; border-radius:999px; white-space:nowrap; }}
.p-dev {{ background:var(--rust-soft); color:var(--rust); }} .p-known {{ background:var(--amber-soft); color:var(--amber); }}
.p-design {{ background:var(--slate-soft); color:var(--slate); }} .p-ok {{ background:var(--moss-soft); color:var(--moss); }}
.p-find {{ background:var(--rust-soft); color:var(--rust); }} .p-clear {{ background:var(--slate-soft); color:var(--slate); }} .p-bad {{ background:var(--rust); color:#fff; }}
.scroll {{ overflow-x:auto; }}
table {{ border-collapse:collapse; width:100%; font-size:14px; }}
th {{ text-align:left; font:600 12px/1.2 var(--display); letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:10px; border-bottom:1px solid var(--line); white-space:nowrap; }}
td {{ padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }}
td small {{ display:block; color:var(--muted); font-size:12.5px; margin-top:2px; }}
td.num {{ text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap; }}
td.num small {{ display:block; font-family:var(--body); }}
.ok {{ color:var(--moss); }} .bad {{ color:var(--rust); font-weight:600; }}
tr:last-child td {{ border-bottom:0; }}
.runs {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }}
@media (max-width:760px) {{ .runs {{ grid-template-columns:1fr; }} }}
.run h3 {{ margin:6px 0 12px; }}
.facts {{ display:grid; grid-template-columns:1fr auto; gap:6px 16px; margin:0; }}
.facts div {{ display:contents; }}
.facts dt {{ color:var(--muted); font-size:14px; }} .facts dd {{ margin:0; font-family:var(--mono); text-align:right; font-variant-numeric:tabular-nums; }}
.cleared {{ display:grid; gap:12px; }}
pre {{ background:var(--surface-2); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; font:13px/1.6 var(--mono); margin:0; }}
</style>
<div class="wrap">
<header class="top">
  <span class="eyebrow">EcoFutures V11 · audited from the chain</span>
  <h1>V11 chain audit: every event, every payment, every failed transaction</h1>
  <p class="lede">Two runs of the simulator on the real V11 contracts, read back from the chain alone and checked against the protocol's rules: {n_checks} rules, {fmt(total_checked)} individual checks. The rules come from the V10 specification, the Lifecycle v5, the fee model and Ravi's review, <i>The Whole Structure</i>, not from the code.</p>
</header>

<section>
  <div class="verdict">
    <div class="stat"><b>{fmt(total_checked)}</b><span>individual checks over two runs</span></div>
    <div class="stat"><b>0</b><span>money lost or created: every unit paid in is paid out or held</span></div>
    <div class="stat warn"><b>2</b><span>contract findings: a spec deviation and a minor bug</span></div>
    <div class="stat"><b>0</b><span>unexpected failed transactions in {fmt(runs["full"]["transactions"] + runs["live"]["transactions"])}</span></div>
  </div>
  <p><b>Since the first version,</b> the configurable simulator's challenge-stress scenario found a second, minor contract bug (F5). Otherwise the contracts did what the rules require in every case but one. <b>Where a covenant's Trust Admin has been removed and no successor named yet, the Trust Admin's 1% goes to the guardian. The specification says to withhold it or send it to the review pool.</b> Every other failure the audit raised was investigated and cleared: one was a wrong expectation in the audit, one an artefact of copying a running chain. Three further findings are design questions the runs measured, not defects.</p>
</section>

<section>
  <h2>Findings</h2>
  <article class="finding">
    <header><span class="id">F1</span><h3>The Trust Admin's fee goes to the guardian when there is no active Trust Admin</h3><span class="pill p-dev">Spec deviation</span></header>
    <dl>
      <dt>What happens</dt><dd>Between the Council removing a failed Trust Admin and naming its successor, each instalment's 1% Trust Admin share is added to the guardian's payment. Both runs met this in the year LK-TA2 was removed (programme year 6) and replaced (year 7).</dd>
      <dt>The specification</dt><dd><blockquote>B1 — Remove the getFirstHolder() fee fallback. Fail closed – withhold or route to the pool.</blockquote><span class="muted">V10 specification, §19 EcoBank. The fee tables (§13; the Fee Settled note) give the Holder 1% and the guardian 90% as the residual, with no rule moving the Holder's share to the guardian.</span></dd>
      <dt>The code</dt><dd><span class="mono">src/EcoBank.sol:493–497</span>: <span class="mono">if (p.holder == address(0) || !isActiveHolder(p.holder)) {{ p.guardianAmount += p.holderFee; p.holderFee = 0; }}</span>, with the comment "covenant value never reaches anyone who did no work". The V11 reference records no decision for it.</dd>
      <dt>Measured</dt><dd>Complete run: {f["holderFeeToGuardian"]["instalments"]} instalments, {f["holderFeeToGuardian"]["amount"]} USDT, {len(f["holderFeeToGuardian"]["covenants"])} covenants. Live run: {l["holderFeeToGuardian"]["instalments"]} instalments, {l["holderFeeToGuardian"]["amount"]} USDT, {len(l["holderFeeToGuardian"]["covenants"])} covenants. Each instalment's other three shares were exact.</dd>
      <dt>Consequence</dt><dd>The guardian is paid more than 90%, and the successor, to whom "fee and authority follow", never receives the gap's fees. Small sums, but it is the pattern CLAUDE.md warns about: a confident rationale for behaviour the specification does not have.</dd>
      <dt>For Ravi</dt><dd>Withhold the share until the successor is named and pay it then, or send it to the covenant's review pool. Either is a few lines in <span class="mono">_distribute</span>; EcoBank has about 5 KB free.</dd>
    </dl>
  </article>
  <article class="finding">
    <header><span class="id">F5</span><h3>A challenger barred from one cure window is barred from every later one</h3><span class="pill p-dev">Contract bug, minor</span></header>
    <dl>
      <dt>What happens</dt><dd>Each challenger may challenge a verification once. <span class="mono">EcoChallenge.raise</span> keys that on (covenant, the window's index, challenger), but a window that covers no new interval, such as a cure re-verification, always has index 0 (<span class="mono">openWindow</span>: <span class="mono">w.index = through &gt; w.through ? ++windowsOpened : 0</span>). So every cure window of a covenant shares one key: a verifier who challenged one cure window gets <span class="mono">AlreadyChallenged</span> on every later one.</dd>
      <dt>Found by</dt><dd>The simulator's "Challenge stress" scenario: 4 reverts in 10 programme-years, and 1 each in a run through the setup screen and in the desktop app. Every invariant still held; only the challenge was refused.</dd>
      <dt>Consequence</dt><dd>In a country with few independent verifiers, later cure windows can run out of anyone allowed to challenge them.</dd>
      <dt>Fix</dt><dd>Key on a number unique to each window, such as a per-covenant count of windows opened (cure windows included), not on the funded-window index. EcoChallenge has about 900 bytes free.</dd>
    </dl>
  </article>
  <article class="finding">
    <header><span class="id">F2</span><h3>An edition change strands requests between verification and mint</h3><span class="pill p-known">Known, measured</span></header>
    <dl>
      <dt>What happens</dt><dd>The land must fit the edition current at the request and at the mint (Lifecycle v5 §5). When the edition moves on in between, the request can never mint; the guardian can only abandon it, after paying the verifier and the attester.</dd>
      <dt>Measured</dt><dd>Complete run: {f["strandedByEdition"]["count"]} of {f["strandedByEdition"]["of"]} requests ({100*f["strandedByEdition"]["count"]/f["strandedByEdition"]["of"]:.0f}%), guardians out {f["strandedByEdition"]["guardianLost"]} USDT. Live run: {l["strandedByEdition"]["count"]} of {l["strandedByEdition"]["of"]}, {l["strandedByEdition"]["guardianLost"]} USDT. The faster the editions move, the more requests are caught.</dd>
      <dt>For Ravi</dt><dd>Check the land only at the request, or let a verified request keep its edition's limits until its listing window closes.</dd>
    </dl>
  </article>
  <article class="finding">
    <header><span class="id">F3</span><h3>Nothing on chain ends the programme, and the TREE cap is all-or-nothing</h3><span class="pill p-design">Design question</span></header>
    <dl>
      <dt>What happens</dt><dd>Editions 1–11 end at Fibonacci-squared thresholds; edition 12 "never ends" (<span class="mono">Tree.editionEndsAt</span>), so covenants keep activating after the land the editions schedule is taken. The only hard limit is TREE's <span class="mono">MAX_SUPPLY</span>, and a claim that would cross it reverts whole (<span class="mono">SupplyCap</span>) rather than minting what remains.</dd>
      <dt>For Ravi</dt><dd>Should admissions close when edition 12 begins? And at the cap, should the last claims be paid in part?</dd>
    </dl>
  </article>
  <article class="finding">
    <header><span class="id">F4</span><h3>TR3 keeps accruing while a covenant's releases are halted</h3><span class="pill p-design">Open policy</span></header>
    <dl>
      <dt>What happens</dt><dd>Three unattested windows in a row halt a covenant's instalments; its TR3 keeps minting. <i>The Whole Structure</i> calls this "the largest open" policy choice.</dd>
      <dt>Measured</dt><dd>{f["halts"]} halts in the complete run, {l["halts"]} in the live run. Every halted covenant that later finished its term released every instalment.</dd>
    </dl>
  </article>
</section>

<section>
  <h2>The rules, and what each run showed</h2>
  <p class="muted">Each count is the number of cases checked: requests, covenants, instalments, claims, verdicts or transactions. A failure the investigation explained is marked with what explained it.</p>
  <div class="card scroll"><table>
    <thead><tr><th>Area</th><th>Rule</th><th class="num" colspan="2">Complete run<br>checked · failed</th><th class="num" colspan="2">Live run<br>checked · failed</th><th>Result</th></tr></thead>
    <tbody>{check_rows()}</tbody>
  </table></div>
</section>

<section>
  <h2>Raised by the audit, and cleared</h2>
  <div class="cleared">
    <article class="finding">
      <header><h3>An upheld documents finding in the term does not move the seat</h3><span class="pill p-clear">Correct per Ravi's review</span></header>
      <p>The first version of the audit expected every upheld term challenge to vacate the seat, as the V10 specification's "misreporting" row does, and flagged {72} verdicts. Ravi's later review, <i>The Whole Structure</i>, splits it: a FIELD (score) finding moves the seat; an EVIDENCE (documents) finding keeps the verifier, flags it, and holds the window's instalments "pending a better record" until a later window settles clean. V11 does exactly that, in <span class="mono">EcoChallenge._applyTermOutcome</span>. The check now holds the code to that rule, and every verdict in both runs passes it.</p>
    </article>
    <article class="finding">
      <header><h3>One covenant in the live run seemed short by one instalment</h3><span class="pill p-clear">Copy artefact</span></header>
      <p>#316 (EFT 300) appeared 14,843.76 USDT short in its sale and 153.69 USDT short in its review pool. The live run was copied while running, and the copy's state already included a window close whose block came two blocks after the copy's last: on the live chain, that close and its release are at block 20,637. Adding them balances both exactly.</p>
    </article>
  </div>
</section>

<section>
  <h2>The two runs</h2>
  <div class="runs">{run_cards()}</div>
  <p class="muted">The complete run's 36 failed transactions are all panel votes the simulation sends knowing the panel may already have its majority. The live run had none.</p>
</section>

<section>
  <h2>How the audit works</h2>
  <p>The audit reads nothing from the simulator: only the chain. It pulls every log since block 0 and every transaction's receipt, decodes them against the compiled ABIs, and checks the rules above. Money is checked three ways: per request (upfront), per covenant (the sale and its review pool), and per transaction (every payment event against the USDT actually transferred). The state the rules compare against is read at the chain's head.</p>
  <pre>cd v11/simulator
RPC=http://127.0.0.1:8545 NAME=live npx tsx scripts/audit.ts     # writes sim/out/audit-live/
python3 ../sim/build_audit.py                                      # this page</pre>
  <p class="muted">A running chain moves on while it is read, so the live run was audited on a copy (<span class="mono">anvil_dumpState</span>, loaded into a second node). The simulator's anvil keeps its history in memory; the copy holds every block and receipt.</p>
</section>
</div>
"""
out = ROOT / "report" / "audit.html"
out.write_text(page)
print(out, len(page) // 1024, "KB")
