# EcoFutures V11 — simulator

The whole V11 protocol on a local anvil chain. You choose what to investigate and how the contracts are configured
(production's settings unless you change them); the app deploys V11, admits the cast, and runs it. Landowners,
verifiers, Trust Admins, patrons, the server and the Council act on their own; every transaction is real and every
figure on screen is read from the chain. The clock moves as fast as you choose, forward or back.

## The desktop app (for anyone)

Download from [Releases](https://github.com/Zeemzo/ecofutures-sim/releases/latest). Nothing else to install: the app carries its own chain.

| | |
|---|---|
| Mac with Apple silicon (M1–M4) | `EcoFutures.Simulator-1.2.0-arm64.dmg` |
| Mac with Intel | `EcoFutures.Simulator-1.2.0.dmg` |
| Windows (64-bit) | `EcoFutures.Simulator-1.2.0-win.zip` |
| Linux (x64) | `EcoFutures.Simulator-1.2.0.AppImage`, or `ecofutures-simulator-1.2.0.tar.gz` |
| Linux (ARM64) | `EcoFutures.Simulator-1.2.0-arm64.AppImage`, or `ecofutures-simulator-1.2.0-arm64.tar.gz` |
| Android (phones and tablets, 64-bit, Android 8 or later) | `EcoFutures.Simulator-1.2.0-android.apk` |

**Mac.** Open the disk image and drag the app to Applications. The app is not signed with an Apple Developer ID,
so the first time macOS refuses to open it: open **System Settings → Privacy & Security**, scroll to the message
about EcoFutures Simulator, and choose **Open Anyway** (on older macOS: right-click the app, **Open**, **Open**).
After that it opens normally.

**Windows.** Unzip the folder anywhere and run `EcoFutures Simulator.exe`. If SmartScreen warns about an
unrecognised app, choose **More info → Run anyway**.

**Linux.** Make the AppImage executable and run it:

```bash
chmod +x EcoFutures.Simulator-1.2.0.AppImage
./EcoFutures.Simulator-1.2.0.AppImage
```

If it asks for FUSE, install `libfuse2` (`libfuse2t64` on Ubuntu 24.04), or use the `.tar.gz`: unpack it and run
`./ecofutures-simulator` inside.

**Android.** Open the APK on the phone (download it there, or copy it over). Android asks once to allow installing
apps from that source (the browser or the file manager): allow it, then **Install**. Play Protect may warn about an
unknown developer: choose **Install anyway**. The app is signed for your own devices, not the Play Store. A run goes
on while the app is in front: Android pauses a background app's network, its own chain included, so the screen stays
on while the app is open.

Each launch starts a fresh chain, and each run begins at the moment you press **Start**, to the second (times are
shown in UTC). Quitting the app stops the chain.

## Setting up a run

Every run starts at the contracts' production settings: a 365-day protocol year, the 30-day review window, the
14-day watchdog and backstop, 7 + 7 + 7-day challenges, three unattested windows to a halt, the production edition
scale, and in every country a 330-day listing window (60 days after the sale on path B). Any of them can be
changed: the screen shows production's value beside each one you change, and **Production settings** puts them all
back.

- **Scenario**: what to investigate. Each sets the actors' behaviour:
  - *Fifteen years of arrivals* — about eight landowners a year for fifteen years, every term run to its end.
  - *Until the programme closes* — landowners arrive until all 21 editions are closed, then every term runs out.
    Its editions are 1/1,000 of production's size, so they fill in a few decades.
  - *A good day, every edition* — nothing goes wrong (no challenges, cancellations or lapses; verifiers on time;
    every window attested; every EFT sold) while landowners arrive until all 21 editions have filled, none by the
    clock. Its editions are small but its plots production-sized, so many covenants reach the 1,000,000 TR3 cap.
  - *Slow uptake: TR3 burned* — production editions and three landowners a year: the first editions fill, the later
    ones run out their eight years unfilled, and the TR3 no land took is burned.
  - *One covenant, start to finish* — a single Sri Lanka request with nothing going wrong; use **Next action**.
  - *Challenge stress*, *Trust Admin failure*, *Late and absent verifiers*, *Path B lapses*,
    *Edition race* (tiny editions that fill within months, one land often running across several), *Breaches and
    cancellations*, and *Custom*.
- **Behaviour**: arrivals a year and for how long; the share of requests that cancel, lapse, are abandoned,
  challenged or go unsold; Path B lapses; how often review windows are attested or challenged; what panels find;
  how late verifiers are; blocks, cancellations, resales, payee switches; the governance calendar.
- **Contracts**: every timing, the halt threshold, V, the fee split, and the edition scale.
- **Countries**: any country by ISO 3166 numeric code — its flow, term range, listing and post-sale windows, its
  fees, and its cast: Trust Admins, organisations each, verifiers per organisation, and its share of arrivals.
- **Flows**: the three V11 flows, changed or added to: any sequence of power, registering the power, agreement,
  deed, recording, attestation, mint and sale the contracts accept. The screen checks each against the contracts'
  rules (a document followed by its attestation, the mint by the sale, an agreement before the mint, a recording
  after the sale, a power registered before anything it signs) and says which one a flow breaks.
- The protocol year can be 365.25 days, the calendar's average, rather than production's 365.

The setup screen checks the configuration against the contracts' own rules before it deploys. Settings are
remembered between launches and can be saved to and loaded from a file. **Reset** returns the chain to empty.

## Watching it

- **Play** at real time, an hour, a day, a week or a month per second, or **Fastest**; **Next action** jumps to
  the next day anyone has something to do. The actors act at midnight (UTC) on the days they planned.
- **Travel in time**: **+1 mo**, **+1 yr**, or a date and **Go**. Forward, the actors live every day up to the
  date; nothing is skipped. Back (**−1 mo**, **−1 yr**, or an earlier date), the chain and the actors return to a
  checkpoint (monthly in a run's first year, quarterly to year five, yearly after) and live the days to the date
  again. Their choices are seeded, so the days replay exactly as before, unless you step in differently.
  **Pause** stops a journey where it is.
- **The platform's figures**: the home page's market cap, TR3 mint price and its change, transactions, EFTs sold,
  TR3 minted and the land left before the next edition (and the TR3 burned by editions the clock closed), with
  charts over the run; and the dashboard's figures for
  every wallet (patrons, guardians, verifiers, Trust Admins).
- **The board**: every request by country and stage. Pick one for its facts, its instalments and history, and to
  step in: raise a challenge (choosing the finding), have its verifier block it, or have the Council hold it.
- **Step in**: a landowner request now, an emergency freeze of a Trust Admin, a country suspended or resumed.
- **Take over**: play any part of the run yourself: an actor, a request, a whole role (every guardian, every verifier,
  every patron, every Trust Admin, the Council, the server, the Foundation) or a country. The simulated actors stop
  doing it; each step they would have taken waits under **Your moves** with the values they would have used, for you
  to change, do or skip, and the clock pauses when one appears. **Act freely** makes any call of the role, as anyone,
  with values you choose. A revert shows the contract's reason. Hand a part back and the simulation carries on with it.
- **The strip**: the six invariants, checked against the contracts' balances at a single block, the land placed
  across the 21 editions, and any call an actor expected to succeed that reverted.
- **Contracts** (the second tab): every contract, function, event and error, with live reads and sends as any actor.

## For developers

Needs Node 18 or later, and Foundry's `anvil` for `./start.sh` and the scripts.

```bash
npm ci
./start.sh                     # anvil on :8545 and the app at http://localhost:5173
npm run app                    # the desktop app from source (needs resources/bin: node scripts/fetch-anvil.mjs)
npm run dist:mac               # release/*.dmg  (Apple silicon and Intel)
npm run dist:win               # release/*-win.zip
npm run dist:linux             # release/*.AppImage and *.tar.gz (x64 and ARM64)
npm run dist:android           # release/*-android.apk (needs the Android SDK with an NDK, and JDK 17)
```

The contracts' ABIs, bytecode and explorer map are committed in `src/abi.json`, `src/bytecode.json` and
`src/surface.json`, so nothing here needs the contracts' source. To run newer contracts, build them in the
contracts repository and point the scripts at that `v11` folder:

```bash
(cd ../evm-eco-futures-contracts/v11 && forge build)
CONTRACTS_DIR=../evm-eco-futures-contracts/v11 npm run abis
CONTRACTS_DIR=../evm-eco-futures-contracts/v11 node scripts/surface.mjs
```

Without the browser, on any anvil node started with `--auto-impersonate --timestamp 1767225600 --gas-limit 100000000`:

```bash
RPC=http://127.0.0.1:8546 SCENARIO=fifteen SEED=1 YEARS=40 npx tsx scripts/headless.ts  # a scenario by id
RPC=http://127.0.0.1:8546 SCENARIO=fifteen YEARS=4 npx tsx scripts/travel.ts             # back in time and replay: must match
RPC=http://127.0.0.1:8545 NAME=live npx tsx scripts/audit.ts                           # audit a run: sim/out/audit-live/
npx tsx scripts/matrix.ts                                                              # every configuration: sim/out/matrix/
python3 sim/check_behaviour.py                                                         # each behaviour setting against the chain
python3 sim/build_matrix.py                                                            # sim/report/matrix.html
```

| | |
|---|---|
| `src/config.ts` | the configuration: contracts, countries, flows, behaviour; the scenarios; validation |
| `src/deploy.ts` | deploys V11 with a configuration, from the compiled bytecode |
| `src/engine.ts` | the actors |
| `src/chain.ts` | viem clients, impersonated sends, the clock, event decoding |
| `src/ledger.ts` | money decoded from events; the census, the platform's figures and the six invariants, at one block |
| `src/feed.ts` | each event as a sentence |
| `src/setup.ts` | the setup screen |
| `src/travel.ts` | checkpoints: the chain's snapshot with the actors' state, to go back to; the midnight stops |
| `src/main.ts` | the clock loop, travel in time, the board, the charts, the wallets, the drawer |
| `src/explorer.ts` | the Contracts tab |
| `electron/` | the desktop app: starts its own anvil, opens the built app against it |
| `android/` | the Android app: the same, in a WebView, with anvil's static Linux build and a launcher for it |
| `scripts/audit.ts` | audits any run from the chain alone against the protocol's rules |
| `sim/` | analysis of the runs the scripts write to `sim/out/` |
