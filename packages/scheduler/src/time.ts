import { DateTime } from "luxon";
import type { Energy, Preferences } from "@life/core";

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms
}

export const MIN = 60_000;

export function ms(iso: string): number {
  const t = DateTime.fromISO(iso, { setZone: true }).toMillis();
  if (Number.isNaN(t)) throw new Error(`Invalid ISO datetime: ${iso}`);
  return t;
}

export function iso(t: number, zone: string): string {
  return DateTime.fromMillis(t, { zone }).toISO({ suppressMilliseconds: true })!;
}

export function localDate(t: number, zone: string): string {
  return DateTime.fromMillis(t, { zone }).toISODate()!;
}

export function atLocal(date: string, hhmm: string, zone: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return DateTime.fromISO(date, { zone }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis();
}

export function startOfLocalDay(t: number, zone: string): number {
  return DateTime.fromMillis(t, { zone }).startOf("day").toMillis();
}

export function endOfLocalDay(t: number, zone: string): number {
  return DateTime.fromMillis(t, { zone }).endOf("day").toMillis();
}

export function addDays(date: string, n: number, zone: string): string {
  return DateTime.fromISO(date, { zone }).plus({ days: n }).toISODate()!;
}

export function minutes(i: Interval): number {
  return Math.max(0, Math.round((i.end - i.start) / MIN));
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Subtract `busy` intervals from `free` intervals. Inputs need not be sorted. */
export function subtract(free: Interval[], busy: Interval[]): Interval[] {
  let result = [...free].sort((a, b) => a.start - b.start);
  for (const b of busy) {
    const next: Interval[] = [];
    for (const f of result) {
      if (!overlaps(f, b)) {
        next.push(f);
        continue;
      }
      if (b.start > f.start) next.push({ start: f.start, end: b.start });
      if (b.end < f.end) next.push({ start: b.end, end: f.end });
    }
    result = next;
  }
  return result.filter((i) => i.end - i.start >= MIN);
}

export function energyAt(t: number, prefs: Preferences): Energy {
  const h = DateTime.fromMillis(t, { zone: prefs.timezone }).hour;
  if (h < 12) return prefs.energyByHour.morning;
  if (h < 17) return prefs.energyByHour.afternoon;
  return prefs.energyByHour.evening;
}

export function formatTime(t: number, zone: string): string {
  return DateTime.fromMillis(t, { zone }).toFormat("h:mma").toLowerCase();
}

export function formatDay(t: number, zone: string, now: number): string {
  const d = DateTime.fromMillis(t, { zone }).startOf("day");
  const n = DateTime.fromMillis(now, { zone }).startOf("day");
  const diff = Math.round(d.diff(n, "days").days);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff > 1 && diff < 7) return d.toFormat("ccc");
  return d.toFormat("ccc d LLL");
}
