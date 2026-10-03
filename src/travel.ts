// Travel in time. The contracts run on the real calendar; to see a later date the actors live through every day up to
// it, and to return to an earlier one the chain and the actors go back to a checkpoint taken on the way. A checkpoint
// is the chain's own snapshot together with everything the actors know and plan at the same block, so going back and
// running forward again replays the same days the same way (the actors' choices are seeded).
import type { Hex } from "viem";
import { snapshot, revertTo } from "./chain";
import type { Engine, EngineState } from "./engine";
import type { Ledger } from "./ledger";
import { DAY, YEAR } from "./model";

/** How long after a checkpoint the next is taken. Every snapshot holds a copy of the chain's state in the node's
 *  memory, and none can be freed while the run goes forward (about 7 MB each by year five of a busy run), so they
 *  thin out as the run ages: monthly in its first year, quarterly to year five, yearly after. Going back to a date
 *  between two checkpoints relives the days from the earlier one. */
export function checkpointGap(sinceStart: number): number {
  return sinceStart < YEAR ? 30 * DAY : sinceStart < 5 * YEAR ? 91 * DAY : YEAR;
}

/** The actors act once a day, at midnight (UTC), on each day anyone has something to do: the chain's clock stops only
 *  at those moments, however the run is played or travelled. A stop on a day nobody acts changes nothing, so a run is
 *  the same lived in one go or in pieces. The next stop after `after`: the first midnight at or past `due`, at least
 *  the next one, and at most `longest` on. */
export function nextStop(after: number, due: number, longest = 90 * DAY): number {
  const tomorrow = Math.ceil((after + 1) / DAY) * DAY;
  return Math.max(tomorrow, Math.min(Math.ceil(due / DAY) * DAY, tomorrow + longest - DAY));
}

export type Checkpoint<X> = { t: number; block: bigint; snap: Hex; engine: EngineState; ledger: unknown; extra: X };

export class Timeline<X> {
  points: Checkpoint<X>[] = [];
  next = 0;

  clear() { this.points = []; this.next = 0; }

  private gapAfter(t: number) { return checkpointGap(t - (this.points[0]?.t ?? t)); }

  /** A checkpoint is due. */
  due(t: number) { return t >= this.next; }

  async take(t: number, block: bigint, engine: Engine, ledger: Ledger, extra: X) {
    const snap = await snapshot();
    this.points.push({ t, block, snap, engine: engine.capture(), ledger: structuredClone({ ...ledger }), extra: structuredClone(extra) });
    this.next = t + this.gapAfter(t);
  }

  /** The latest checkpoint at or before t (the first one if t is earlier than all). */
  before(t: number): number {
    let i = 0;
    while (i + 1 < this.points.length && this.points[i + 1].t <= t) i++;
    return i;
  }

  /** Returns the chain, the actors and the money record to checkpoint i. Later checkpoints are gone: the chain drops
   *  every snapshot after the one it returns to, so the days after it will be lived again. */
  async restore(i: number, engine: Engine, ledger: Ledger): Promise<Checkpoint<X>> {
    const cp = this.points[i];
    await revertTo(cp.snap);
    cp.snap = await snapshot(); // a revert uses the snapshot up: take it again so this moment stays reachable
    this.points.length = i + 1;
    engine.restore(cp.engine);
    Object.assign(ledger, structuredClone(cp.ledger));
    this.next = cp.t + this.gapAfter(cp.t);
    return cp;
  }
}
