import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { beforeEach, describe, expect, it } from "vitest";
import { createServices, type Services } from "../src/app";
import { occurrences, shiftTitle, syncFeed, type Feed } from "../src/connectors/ical";
import { openDb } from "../src/db";

const roster = readFileSync(new URL("./fixtures/humanforce-roster.ics", import.meta.url), "utf8");
const TZ = "Australia/Melbourne";
const local = (iso: string) => DateTime.fromISO(iso).setZone(TZ);
const feed: Feed = { id: "hf", name: "Humanforce", url: "upload:Humanforce", kind: "roster", lock: "hard" };

let s: Services;
beforeEach(async () => {
  s = createServices(await openDb({ memory: true }));
  await s.store.setPrefs({ timezone: TZ }, { actor: "system" });
});

describe("Humanforce roster import (your real file)", () => {
  it("reads floating times as Melbourne wall-clock time, including the overnight shift", () => {
    const occ = occurrences(roster, new Date("2026-10-01"), new Date("2027-01-01"), TZ);
    expect(occ).toHaveLength(16);
    const first = occ.find((o) => o.uid.startsWith("ba87da04"))!;
    expect(DateTime.fromJSDate(first.start).setZone(TZ).toFormat("ccc d LLL HH:mm")).toBe("Sat 31 Oct 16:30");
    expect(DateTime.fromJSDate(first.end).setZone(TZ).toFormat("ccc d LLL HH:mm")).toBe("Sun 1 Nov 00:36");
  });

  it("makes readable shift titles from the details", () => {
    const occ = occurrences(roster, new Date("2026-10-01"), new Date("2027-01-01"), TZ);
    const byUid = (p: string) => shiftTitle(occ.find((o) => o.uid.startsWith(p))!);
    expect(byUid("ba87da04")).toBe("Luna Park · Cafe Cook");
    expect(byUid("2900d22f")).toBe("Luna Park · Cash Handling (Diner)");
    expect(byUid("2c3ab184")).toBe("Luna Park · Events Cook (Events) — Linfox Retail");
    expect(byUid("a03ce752")).toBe("Luna Park · Cafe Cook (SAW)");
  });

  it("imports shifts as hard, confirmed work events and proposes removals when a shift disappears", async () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const r = await syncFeed(s.store, feed, { text: roster, now });
    expect(r.created).toBeGreaterThanOrEqual(10);
    const events = await s.store.list("event");
    const sat = events.find((e) => local(e.start).toFormat("yyyy-LL-dd HH:mm") === "2026-11-28 12:00")!;
    expect(sat).toMatchObject({ lock: "hard", certainty: "confirmed", area: "work", title: "Luna Park · Cafe Cook (Food Cafe)" });
    expect(local(sat.end).toFormat("HH:mm")).toBe("20:30");

    // Next week's roster no longer has the Sat 28 Nov shift → proposed removal, not a silent delete.
    const without = roster.replace(/BEGIN:VEVENT\r?\nUID:ad256b76[\s\S]*?END:VEVENT\r?\n/, "");
    const r2 = await syncFeed(s.store, feed, { text: without, now });
    expect(r2.proposedRemovals).toBe(1);
    expect((await s.store.list("event")).some((e) => e.id === sat.id)).toBe(true);
    const proposed = await s.store.listChanges({ status: "proposed" });
    expect(proposed.find((c) => c.entityId === sat.id)?.op).toBe("delete");
    // Re-importing doesn't duplicate or re-propose.
    const r3 = await syncFeed(s.store, feed, { text: without, now });
    expect(r3).toMatchObject({ created: 0, proposedRemovals: 0 });
  });
});
