import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";

/** Constant-time string equality (length leak is fine; content isn't). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Validate an X-Twilio-Signature header: base64(HMAC-SHA1(authToken,
 * url + form params concatenated key+value in sorted key order)).
 */
export function validateTwilioSignature(opts: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | undefined;
}): boolean {
  if (!opts.signature) return false;
  let data = opts.url;
  for (const key of Object.keys(opts.params).sort()) data += key + opts.params[key];
  const expected = createHmac("sha1", opts.authToken).update(data, "utf8").digest("base64");
  return safeEqual(expected, opts.signature);
}

// ---------- one-time media-stream tokens ----------
// Each token authorizes ONE stream for ONE business. Phone path: /twilio/voice
// mints one per verified webhook and embeds it in the TwiML <Parameter>. Web
// path: POST /api/businesses/:id/stream-token mints one for the authenticated
// tenant's dialer. In-memory is fine: the stream connects within seconds, from
// the same process.

export interface StreamGrant {
  businessId: string;
  /** True when minted for a browser/CLI test dialer rather than a phone call. */
  web: boolean;
}

const streamTokens = new Map<string, StreamGrant & { expiresAt: number }>();

export function mintStreamToken(grant: StreamGrant, ttlMs = 5 * 60_000): string {
  const now = Date.now();
  for (const [t, g] of streamTokens) if (g.expiresAt < now) streamTokens.delete(t);
  const token = randomBytes(16).toString("hex");
  streamTokens.set(token, { ...grant, expiresAt: now + ttlMs });
  return token;
}

/** Single-use: returns the grant and burns the token, or undefined. */
export function consumeStreamToken(token: string | undefined): StreamGrant | undefined {
  if (!token) return undefined;
  const g = streamTokens.get(token);
  if (!g) return undefined;
  streamTokens.delete(token);
  if (g.expiresAt < Date.now()) return undefined;
  return { businessId: g.businessId, web: g.web };
}

// ---------- log redaction ----------

/** Mask all but the last 4 digits of a phone number for logs. */
export function maskPhone(s: string | undefined): string {
  if (!s) return "(none)";
  return s.replace(/\d(?=\d{4})/g, "•");
}

// ---------- SSRF-safe fetching ----------

export function ipIsPrivate(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (ip.startsWith("192.0.0.")) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  // v4-embedded forms — new URL() normalizes ::ffff:127.0.0.1 to hex (::ffff:7f00:1),
  // so both spellings must funnel back through the IPv4 checks. Also covers the
  // deprecated v4-compatible form (::a.b.c.d) and the NAT64 prefix (64:ff9b::/96).
  const embedded = low.match(/^(?:::ffff:|::|64:ff9b::)((?:\d+\.\d+\.\d+\.\d+)|(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}))$/);
  if (embedded) {
    const tail = embedded[1];
    if (tail.includes(".")) return ipIsPrivate(tail);
    const [hi, lo] = tail.split(":").map((h) => parseInt(h, 16));
    return ipIsPrivate(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/** Reject URLs whose host is (or resolves to) a private/internal address. */
export async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new Error(`Refusing to fetch private address ${host}`);
    return;
  }
  const lowered = host.toLowerCase();
  if (lowered === "localhost" || lowered.endsWith(".localhost") || lowered.endsWith(".local") || lowered.endsWith(".internal")) {
    throw new Error(`Refusing to fetch internal hostname ${host}`);
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) throw new Error(`Refusing to fetch ${host} — it resolves to a private address`);
  }
}

/**
 * fetch() for user-supplied URLs: validates every redirect hop against
 * private/internal hosts instead of following redirects blindly.
 */
export async function fetchPublicUrl(url: string, init?: RequestInit): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicHost(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      await res.body?.cancel();
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}
