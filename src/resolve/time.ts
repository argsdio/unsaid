import type { Blackout, Occasion, Slot, TimeWindow } from "../contracts.ts";
import { WINDOWS } from "./occasion.ts";
import { normalise } from "./gazetteer.ts";

// Naive local ISO (no timezone suffix). Everyone is in one room in one city
// tonight, and a Z suffix would only invite off-by-five-hours confusion.
function iso(day: Date, minutes: number): string {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

// How a bare hour is read depends on the occasion: "11" is 11am for brunch and
// 11pm for drinks. Defaulting everything to PM is only right for dinner.
function clock(hour: string, minute?: string, meridiem?: string, occasion: Occasion = "dinner"): number {
  let h = Number(hour);
  const m = minute ? Number(minute) : 0;
  if (meridiem === "pm" && h < 12) h += 12;
  else if (meridiem === "am" && h === 12) h = 0;
  else if (!meridiem && h >= 1 && h <= 11 && !WINDOWS[occasion].amHours.includes(h)) h += 12;
  return h * 60 + m;
}

const RANGE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until|till|til|thru|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/;
const AFTER = /(?:after|from|starting|past|post)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/;
const BEFORE = /(?:before|by|until|till|til)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/;

// Which of the four shapes a person used. The resolved window is always a pair,
// because intersecting needs one, but echoing that pair back at somebody who
// said "10 am" tells them they said "10am-2pm" -- which is how two different
// answers looked identical in a real run.
export type WindowShape = "range" | "from" | "until" | "at";

export function windowShape(raw: string): WindowShape {
  const text = normalise(raw);
  if (RANGE.test(text)) return "range";
  if (BEFORE.test(text)) return "until";
  if (AFTER.test(text)) return "from";
  return "at";
}

// How to say a resolved window back to the person who set it, in their own terms.
export function describeWindow(raw: string, window: TimeWindow): string {
  const from = hhmm(window.start);
  const to = hhmm(window.end);
  switch (windowShape(raw)) {
    case "range":
      return `${from}\u2013${to}`;
    case "until":
      return `before ${to}`;
    case "from":
      return `from ${from}`;
    // A bare clock is a start, not a range: "10 am" means from 10, and the end
    // is whenever this kind of outing stops being plausible.
    case "at":
      return `from ${from}`;
  }
}

function hhmm(iso: string): string {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  const hour = ((h ?? 0) % 12) || 12;
  const suffix = (h ?? 0) < 12 ? "am" : "pm";
  return m ? `${hour}:${String(m).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

export function resolveWindow(
  raw: string,
  day: Date = new Date(),
  occasion: Occasion = "dinner",
): Slot<TimeWindow> {
  const { start: DAY_START, end: DAY_END } = WINDOWS[occasion];
  const text = normalise(raw);
  if (!text) return { raw, value: null, confidence: "low" };

  const range = text.match(RANGE);
  if (range?.[1] && range[4]) {
    const start = clock(range[1], range[2], range[3], occasion);
    const end = clock(range[4], range[5], range[6], occasion);
    if (end > start) {
      return { raw, value: { start: iso(day, start), end: iso(day, end) }, confidence: "high" };
    }
  }

  const after = text.match(AFTER);
  if (after?.[1]) {
    const start = clock(after[1], after[2], after[3], occasion);
    return { raw, value: { start: iso(day, start), end: iso(day, DAY_END) }, confidence: "high" };
  }

  const before = text.match(BEFORE);
  if (before?.[1]) {
    const end = clock(before[1], before[2], before[3], occasion);
    return { raw, value: { start: iso(day, DAY_START), end: iso(day, end) }, confidence: "high" };
  }

  if (/after work|post work|evening|tonight/.test(text)) {
    return { raw, value: { start: iso(day, 18 * 60), end: iso(day, DAY_END) }, confidence: "low" };
  }
  if (/anytime|any time|whenever|free all|all night|im free|flexible|open/.test(text)) {
    return { raw, value: { start: iso(day, DAY_START), end: iso(day, DAY_END) }, confidence: "low" };
  }
  // A bare clock -- "7pm", "8ish", "around 7:30" (which normalise() turns into
  // "around 7 30"). Treated as "from then on", which is what someone answering
  // "what time works?" with a single time means.
  const bare = text.match(/\b(\d{1,2})(?:\s+(\d{2}))?\s*(am|pm)?(?:\s*ish)?\b/);
  if (bare?.[1]) {
    const hour = Number(bare[1]);
    const minute = bare[2] ? Number(bare[2]) : 0;
    if (hour >= 1 && hour <= 23 && minute < 60) {
      const start = clock(bare[1], bare[2], bare[3], occasion);
      if (start < DAY_END) {
        return { raw, value: { start: iso(day, start), end: iso(day, DAY_END) }, confidence: "low" };
      }
    }
  }

  if (/\bearly\b/.test(text)) {
    return { raw, value: { start: iso(day, DAY_START), end: iso(day, 20 * 60) }, confidence: "low" };
  }
  if (/\blate\b/.test(text)) {
    return { raw, value: { start: iso(day, 20 * 60), end: iso(day, DAY_END) }, confidence: "low" };
  }

  return { raw, value: null, confidence: "low" };
}

export function defaultWindow(day: Date = new Date(), occasion: Occasion = "dinner"): TimeWindow {
  const { start, end } = WINDOWS[occasion];
  return { start: iso(day, start), end: iso(day, end) };
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// Trim a per-plan window against standing blackouts for that weekday. A blackout
// that swallows the window returns null: that person cannot make it at all.
// Interior blackouts are ignored rather than splitting the window in two.
export function clipWindow(
  window: TimeWindow,
  blackouts: Blackout[],
  day: Date = new Date(),
): TimeWindow | null {
  const weekday = day.getDay();
  let start = minutes(window.start.slice(11, 16));
  let end = minutes(window.end.slice(11, 16));

  for (const blackout of blackouts) {
    if (!blackout.days.includes(weekday)) continue;
    const bStart = minutes(blackout.start);
    const bEnd = minutes(blackout.end);
    if (bStart <= start && bEnd >= end) return null;
    if (bStart <= start && bEnd > start) start = bEnd;
    else if (bEnd >= end && bStart < end) end = bStart;
  }

  if (start >= end) return null;
  return { start: iso(day, start), end: iso(day, end) };
}
