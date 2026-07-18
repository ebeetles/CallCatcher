import type { DayKey, WeekHours } from "./types";

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtAgo(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return fmtDateTime(iso);
}

export function fmtDur(sec?: number): string {
  if (sec === undefined || sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Dollars with sensible precision: sub-cent amounts get 4 decimals. */
export function money(n?: number, dp?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  const places = dp ?? (n !== 0 && Math.abs(n) < 0.05 ? 4 : 2);
  return `$${n.toFixed(places)}`;
}

export function fmtPhone(e164?: string): string {
  if (!e164) return "";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const WEEKDAY_TO_KEY: Record<string, DayKey> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

/**
 * Open/closed right now, computed client-side from the profile's hours + timezone.
 * (Mirrors the server's approach: timezone math stays in code, never in the LLM.)
 */
export function openNow(hours: WeekHours, timezone: string): { open: boolean; label: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const key = WEEKDAY_TO_KEY[get("weekday")];
    const now = `${get("hour")}:${get("minute")}`;
    const day = key ? hours[key] : undefined;
    if (!day || !day.open) return { open: false, label: "Closed today" };
    for (const r of day.ranges) {
      if (now >= r.start && now < r.end) return { open: true, label: `Open now · until ${r.end}` };
    }
    const next = day.ranges.find((r) => r.start > now);
    if (next) return { open: false, label: `Closed · opens ${next.start}` };
    return { open: false, label: "Closed now" };
  } catch {
    return { open: false, label: "" };
  }
}

/** Compact "Mon–Fri 09:00–17:00" style summary for cards. */
export function hoursSummary(hours: WeekHours): string {
  const openDays = (Object.keys(hours) as DayKey[]).filter((k) => hours[k].open);
  if (openDays.length === 0) return "No hours set";
  return `Open ${openDays.length} days/week`;
}

export function listTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf === "function") {
    try {
      return intl.supportedValuesOf("timeZone");
    } catch {
      // fall through
    }
  }
  return [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "Europe/London",
    "Australia/Sydney",
  ];
}
