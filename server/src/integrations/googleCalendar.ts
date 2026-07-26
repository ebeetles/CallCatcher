/**
 * Per-business Google Calendar integration.
 *
 * Managed model: one platform-level OAuth app (GOOGLE_CLIENT_ID/SECRET). Each
 * business owner authorizes their OWN calendar once via a signed consent link;
 * we persist only their refresh token (encrypted at rest). At call time the
 * receptionist can check real availability (freeBusy) and book directly
 * (events.insert) onto that calendar.
 *
 * No googleapis dependency — the three endpoints we need (token, freeBusy,
 * events.insert) are plain HTTPS calls. When the platform OAuth app isn't
 * configured (zero-config/mock mode, tests), every function operates in a mock
 * mode so the whole flow stays demoable and testable with no real Google keys.
 */
import { config, googleConfigured, googleRedirectUri } from "../config.ts";
import { calendarIntegrations } from "../db.ts";
import { decryptSecret, encryptSecret, secretsConfigured } from "../crypto.ts";
import type { BusinessProfile } from "../types.ts";

const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE = "https://oauth2.googleapis.com/revoke";
const CAL_API = "https://www.googleapis.com/calendar/v3";

/** Scopes: identify the account (email) + read availability + create events. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

/** Sentinel refresh token stored for mock connections (no real Google app). */
const MOCK_REFRESH = "mock-refresh-token";

export function isMock(): boolean {
  return !googleConfigured();
}

// ---------- OAuth ----------

/** The Google consent URL a business owner opens to authorize their calendar. */
export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    include_granted_scopes: "true",
    // Force a refresh_token every time, even on re-consent.
    prompt: "consent",
    state,
  });
  return `${OAUTH_AUTH}?${params.toString()}`;
}

export interface ExchangeResult {
  refreshToken: string;
  accountEmail?: string;
  scopes: string;
}

/** Exchange an authorization code for tokens; extract the account email. */
export async function exchangeCode(code: string): Promise<ExchangeResult> {
  if (isMock()) {
    return { refreshToken: MOCK_REFRESH, accountEmail: "owner@calendar.mock", scopes: GOOGLE_SCOPES };
  }
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { refresh_token?: string; id_token?: string; scope?: string };
  if (!json.refresh_token) {
    throw new Error("Google did not return a refresh token (the account may have already granted access — revoke and retry).");
  }
  return { refreshToken: json.refresh_token, accountEmail: emailFromIdToken(json.id_token), scopes: json.scope ?? GOOGLE_SCOPES };
}

/** Decode the email claim from an OpenID id_token (no verification needed — we just got it from Google over TLS). */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort revoke at Google so disconnecting is clean. Never throws. */
export async function revoke(refreshTokenEnc: string): Promise<void> {
  if (isMock()) return;
  try {
    const token = decryptSecret(refreshTokenEnc);
    if (token === MOCK_REFRESH) return;
    await fetch(OAUTH_REVOKE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch (err) {
    console.error("[gcal] revoke failed:", (err as Error)?.message ?? err);
  }
}

// ---------- access token cache ----------

const accessCache = new Map<string, { token: string; expiresAt: number }>();

async function accessTokenFor(businessId: string): Promise<string> {
  const cached = accessCache.get(businessId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const rec = calendarIntegrations.connected(businessId);
  if (!rec) throw new Error("calendar not connected");
  const refreshToken = decryptSecret(rec.refreshTokenEnc);

  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  accessCache.set(businessId, { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

/** Drop any cached access token (e.g. on disconnect). */
export function clearAccessCache(businessId: string): void {
  accessCache.delete(businessId);
}

// ---------- timezone helpers ----------
// The receptionist supplies a local wall-clock time (e.g. "2026-07-28T14:00:00")
// resolved from the {{NOW}} context; we anchor it to the business timezone.

function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

/** Convert a naive local wall-clock ISO ("YYYY-MM-DDTHH:mm[:ss]") in timeZone to a UTC instant. */
function wallTimeToUtc(local: string, timeZone: string): Date {
  const naive = local.replace(/(Z|[+-]\d{2}:?\d{2})$/, ""); // strip any zone the model tacked on
  const asIfUtc = new Date(naive + "Z").getTime();
  if (Number.isNaN(asIfUtc)) throw new Error(`invalid datetime: ${local}`);
  const offset = tzOffsetMinutes(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - offset * 60000);
}

function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60000);
}

// ---------- availability & booking ----------

export interface Slot {
  /** Local wall-clock start, e.g. "2026-07-28T14:00:00". */
  start: string;
  durationMin: number;
  business: BusinessProfile;
}

export interface AvailabilityResult {
  free: boolean;
  /** Busy windows overlapping the request (RFC3339), for the model to reason about. */
  busy: Array<{ start: string; end: string }>;
}

/** Is the [start, start+duration) window free on the connected calendar? */
export async function checkAvailability(slot: Slot): Promise<AvailabilityResult> {
  const rec = calendarIntegrations.connected(slot.business.id);
  if (!rec) throw new Error("calendar not connected");
  const startUtc = wallTimeToUtc(slot.start, slot.business.timezone);
  const endUtc = addMinutes(startUtc, slot.durationMin);

  if (isMock()) return { free: true, busy: [] };

  const token = await accessTokenFor(slot.business.id);
  const res = await fetch(`${CAL_API}/freeBusy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: startUtc.toISOString(),
      timeMax: endUtc.toISOString(),
      timeZone: slot.business.timezone,
      items: [{ id: rec.calendarId }],
    }),
  });
  if (!res.ok) throw new Error(`Google freeBusy failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { calendars: Record<string, { busy: Array<{ start: string; end: string }> }> };
  const busy = json.calendars?.[rec.calendarId]?.busy ?? [];
  return { free: busy.length === 0, busy };
}

export interface BookInput extends Slot {
  summary: string;
  description?: string;
  /** Caller's email, added as an attendee so they get an invite too. */
  attendeeEmail?: string;
}

export interface BookResult {
  eventId: string;
  htmlLink?: string;
  /** Confirmed local start, echoed back for the confirmation line. */
  start: string;
}

/** Create the event on the business's connected calendar. */
export async function bookEvent(input: BookInput): Promise<BookResult> {
  const rec = calendarIntegrations.connected(input.business.id);
  if (!rec) throw new Error("calendar not connected");
  const tz = input.business.timezone;
  const startUtc = wallTimeToUtc(input.start, tz);
  const endUtc = addMinutes(startUtc, input.durationMin);
  // Send wall-clock dateTime + timeZone so Google stores the intended local time.
  const startLocal = input.start.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
  const endLocal = toLocalIso(endUtc, tz);

  if (isMock()) {
    return { eventId: `mockevt_${Date.now()}`, htmlLink: "https://calendar.google.com/mock-event", start: input.start };
  }

  const token = await accessTokenFor(input.business.id);
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(rec.calendarId)}/events?sendUpdates=all`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: input.summary,
      description: input.description,
      start: { dateTime: startLocal, timeZone: tz },
      end: { dateTime: endLocal, timeZone: tz },
      attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Google events.insert failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { id: string; htmlLink?: string };
  return { eventId: json.id, htmlLink: json.htmlLink, start: input.start };
}

/** Format a UTC instant as a naive local wall-clock ISO in timeZone. */
function toLocalIso(date: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

// ---------- connect helpers ----------

/** Persist a connection from an OAuth exchange (encrypting the refresh token). */
export function saveConnection(businessId: string, ex: ExchangeResult): void {
  // Real tokens must be encrypted at rest; the mock sentinel (no real Google
  // app) is stored as-is so the zero-config demo works without a SECRETS_KEY.
  if (!isMock() && !secretsConfigured()) {
    throw new Error("SECRETS_KEY must be set to store a real Google refresh token (generate with `openssl rand -hex 32`).");
  }
  calendarIntegrations.upsert({
    businessId,
    accountEmail: ex.accountEmail,
    refreshTokenEnc: secretsConfigured() ? encryptSecret(ex.refreshToken) : ex.refreshToken,
    scopes: ex.scopes,
  });
  clearAccessCache(businessId);
}
