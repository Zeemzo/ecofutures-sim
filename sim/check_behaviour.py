#!/usr/bin/env python3
"""Checks each behaviour knob of the simulator against what happened on chain.

For every configuration in sim/out/matrix/<name>/ (simulator/scripts/matrix.ts), the configured rate of each
knob is compared with the rate observed in the run's own events (events.jsonl, from the audit). A knob passes
when the observed rate is within three standard errors of the configured one (binomial), or when the
difference has a stated cause in how the protocol works. Writes sim/out/matrix/behaviour.json.
"""
import json, math, pathlib, collections

ROOT = pathlib.Path(__file__).resolve().parent / "out" / "matrix"
DAY = 86400
results = []


def load(name):
    d = ROOT / name
    cfg = json.load(open(d / "config.json"))["scenario"]
    ev = [json.loads(l) for l in open(d / "events.jsonl")]
    return cfg, ev


def compare(case, knob, configured, hits, n, unit="%", note="", lower_only=False):
    """configured and the observed share hits/n, as fractions; three standard errors of slack."""
    if n == 0:
        results.append({"case": case, "knob": knob, "configured": configured, "observed": None, "n": 0, "ok": None, "note": "nothing to measure"})
        return
    obs = hits / n
    se = math.sqrt(max(configured * (1 - configured), 1e-9) / n)
    ok = abs(obs - configured) <= 3 * se + 0.005 or (lower_only and obs <= configured + 3 * se)
    results.append({"case": case, "knob": knob, "configured": configured, "observed": obs, "n": n, "ok": ok, "note": note, "unit": unit})


def by(ev, name):
    return [e for e in ev if e["name"] == name]


for name in ["fifteen", "challenges", "late", "breaches", "pathb", "new-countries", "holder-failure", "fees", "lean-cast"]:
    if not (ROOT / name / "events.jsonl").exists():
        continue
    cfg, ev = load(name)
    b = cfg["behaviour"]
    req = by(ev, "VerificationRequested")
    n_req = len(req)
    ended = collections.Counter(int(e["a"]["reason"]) for e in by(ev, "RequestEnded"))

    # arrivals a year: Poisson; the run's arrival period is up to arrivals' end
    if b["maxRequests"] == 0:
        run_years = json.load(open(ROOT / name / "config.json")).get("years") or b["arrivalYears"]
        yrs = min(b["arrivalYears"], run_years)
        rate = n_req / yrs
        se = math.sqrt(b["arrivalsPerYear"] / yrs)
        results.append({"case": name, "knob": "landowners a year", "configured": b["arrivalsPerYear"], "observed": rate, "n": n_req,
                        "ok": abs(rate - b["arrivalsPerYear"]) <= 3 * se + 0.5, "note": "", "unit": "/yr"})

    # country weights
    w = {c["code"]: c["weight"] for c in cfg["countries"]}
    tw = sum(w.values())
    cnt = collections.Counter(int(e["a"]["country"]) for e in req)
    for code, weight in w.items():
        if weight == 0:
            continue
        compare(name, f"share of requests: {next(c['name'] for c in cfg['countries'] if c['code'] == code)}", weight / tw, cnt[code], n_req,
                note="a suspended country refuses arrivals, so its share can fall short" if b["governanceCalendar"] else "", lower_only=b["governanceCalendar"])

    # pre-mint fates: each request draws one
    compare(name, "the guardian cancels", b["cancelPct"] / 100, ended[1], n_req)
    claims = collections.Counter(int(e["a"]["requestId"]) for e in by(ev, "RequestClaimed"))
    reopened = {int(e["a"]["requestId"]) for e in by(ev, "RequestReopened")}
    relapsed = sum(1 for r, c in claims.items() if c > 1 and r not in reopened)
    compare(name, "a claim lapses and another verifier takes it", b["claimLapsePct"] / 100, relapsed, n_req)
    attested = {int(e["a"]["requestId"]) for e in by(ev, "AttestationPaid")}
    minted = {int(e["a"]["requestId"]) for e in by(ev, "CovenantMinted")}
    abandons = [int(e["a"]["requestId"]) for e in by(ev, "RequestEnded") if int(e["a"]["reason"]) == 2]
    chosen = sum(1 for r in abandons if r not in attested)  # stranded requests abandon after the attestation
    compare(name, "the guardian abandons after the verification", b["abandonPct"] / 100, chosen, n_req)
    pre = [e for e in by(ev, "ChallengeRaised") if int(e["a"]["kind"]) == 1]
    compare(name, "challenged in the watchdog window", b["preMintChallengePct"] / 100, len(pre), n_req,
            note="a challenge needs an independent verifier in the country; a request the guardian cancels never reaches the window", lower_only=True)
    compare(name, "closes unsold", b["unsoldPct"] / 100, ended[4], n_req, lower_only=True,
            note="a request that ends earlier never lists")

    # path B lapses, of path B requests
    pathb = {c["code"] for c in cfg["countries"] if c["flowId"] == 3}
    nb = sum(1 for e in req if int(e["a"]["country"]) in pathb)
    if nb:
        lapses = by(ev, "SaleLapsed")
        compare(name, "path B: nothing recorded after the sale", b["pathBLapseNothingPct"] / 100, sum(1 for e in lapses if e["a"]["relistable"]), nb, lower_only=True,
                note="only requests that reach a sale can lapse")
        compare(name, "path B: the recording is never attested", b["pathBLapseUnattestedPct"] / 100, sum(1 for e in lapses if not e["a"]["relistable"]), nb, lower_only=True,
                note="only requests that reach a sale can lapse")

    # review windows
    windows = by(ev, "WindowOpened")
    att = by(ev, "VerificationAttested")
    term = [e for e in by(ev, "ChallengeRaised") if int(e["a"]["kind"]) == 2]
    compare(name, "a review window is attested", b["attestPct"] / 100, len(att), len(windows), lower_only=True,
            note="an attestor must be independent of the verifier, its organisation and Trust Admin; the window's own verifier may be reseated first")
    compare(name, "a review window is challenged", b["challengePct"] / 100, len(term), len(windows), lower_only=True,
            note="a challenger must be independent too")

    # what panels found, by kind
    kind = {e["a"]["challengeId"]: int(e["a"]["kind"]) for e in by(ev, "ChallengeRaised")}
    out = collections.Counter()
    for e in by(ev, "ChallengeDetermined"):
        k = kind.get(e["a"]["challengeId"])
        f = 3 if e["a"]["inBreach"] else (int(e["a"]["finding"]) if e["a"]["upheld"] else 0)
        out[(k, f)] += 1
    for e in by(ev, "ChallengeLapsed"):
        out[(kind.get(e["a"]["challengeId"]), 4)] += 1
    for e in by(ev, "ChallengeWithdrawn"):
        out[(kind.get(e["a"]["challengeId"]), 5)] += 1
    labels = ["dismissed", "upheld: score", "upheld: documents", "in breach", "lapsed", "withdrawn"]
    for k, weights in [(1, b["preMintOutcomes"]), (2, b["termOutcomes"])]:
        ws = [x if not (k == 1 and i == 3) else 0 for i, x in enumerate(weights)]
        total = sum(ws)
        n = sum(out[(k, i)] for i in range(6))
        for i, x in enumerate(ws):
            if total and (x or out[(k, i)]):
                compare(name, f"{'pre-mint' if k == 1 else 'term'} panel finds: {labels[i]}", x / total, out[(k, i)], n,
                        note="a panel's planned finding can still lapse at its deadline" if i in (0, 1, 2, 3) else "")

    # verifiers' lateness, from each verification against its interval's due date
    sched = {e["a"]["tokenId"]: (int(e["a"]["termStart"]), int(e["a"]["interval"])) for e in by(ev, "Activated")}
    last = {}
    late = collections.Counter()
    nver = 0
    for e in by(ev, "CovenantVerified"):
        t = e["a"]["tokenId"]
        k = int(e["a"]["verifiedThrough"])
        if t in sched and k > last.get(t, 0):
            s, iv = sched[t]
            due = s + (last.get(t, 0) + 1) * iv
            delay = (e["t"] - due) / DAY
            # the clock steps at most a day past an actor's planned moment
            late["on time" if delay < 20.5 else "a little late" if delay < 29.5 else "very late"] += 1
            nver += 1
        last[t] = k
    if nver:
        compare(name, "verifiers re-verify on time (within 20 days)", b["onTimePct"] / 100, late["on time"], nver,
                note="a window still open or an undecided challenge delays a verification past its plan", lower_only=True)
        compare(name, "verifiers re-verify a little late (20-28 days)", b["littleLatePct"] / 100, late["a little late"], nver)
        compare(name, "verifiers re-verify very late (40-59 days)", (100 - b["onTimePct"] - b["littleLatePct"]) / 100, late["very late"], nver)

    # blocks and their ends
    nv = len(by(ev, "CovenantVerified"))
    compare(name, "a re-verification finds a breach and blocks", b["blockPermille"] / 1000, len(by(ev, "CovenantBlocked")), nv, unit="‰", lower_only=True,
            note="no block after the term's end, and at most two a window")
    blocks = len(by(ev, "CovenantBlocked"))
    cancels = sum(1 for e in by(ev, "CovenantCancelled"))
    compare(name, "of the blocks, end in cancellation", b["cancelOfBlockPct"] / 100, cancels, blocks,
            note="a block still open at the run's end has not resolved yet", lower_only=True)

for r in results:
    flag = "  " if r["ok"] else ("--" if r["ok"] is None else "XX")
    obs = "—" if r["observed"] is None else (f"{r['observed']:.3f}" if r.get("unit") != "/yr" else f"{r['observed']:.1f}")
    print(f"{flag} {r['case']:15} {r['knob'][:52]:52} set {r['configured']:<8.3f} seen {obs:>7}  n={r['n']}")
json.dump(results, open(ROOT / "behaviour.json", "w"), indent=1)
print(f"\n{sum(1 for r in results if r['ok'])} of {sum(1 for r in results if r['ok'] is not None)} measured knobs within tolerance")
