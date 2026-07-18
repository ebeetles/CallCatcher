import { config } from "../config.ts";

/**
 * Minimal Twilio REST client (no SDK dependency). Basic-auth'd form posts
 * against the 2010-04-01 API — numbers, call control, that's all we need.
 */

const BASE = "https://api.twilio.com/2010-04-01";

function authHeader(): string {
  return "Basic " + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
}

export function twilioConfigured(): boolean {
  return !!(config.twilioAccountSid && config.twilioAuthToken);
}

async function twilioFetch(path: string, init?: { method?: string; form?: Record<string, string> }) {
  const res = await fetch(`${BASE}/Accounts/${config.twilioAccountSid}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: authHeader(),
      ...(init?.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.form ? new URLSearchParams(init.form).toString() : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    // leave empty
  }
  if (!res.ok) {
    throw new Error(`Twilio ${res.status}: ${json?.message ?? text.slice(0, 200)}`);
  }
  return json;
}

export interface AvailableNumber {
  e164: string;
  friendly: string;
  locality?: string;
  region?: string;
}

export async function searchNumbers(opts: { areaCode?: string; contains?: string }): Promise<AvailableNumber[]> {
  const params = new URLSearchParams({ VoiceEnabled: "true", PageSize: "12" });
  if (opts.areaCode) params.set("AreaCode", opts.areaCode);
  if (opts.contains) params.set("Contains", opts.contains);
  const json = await twilioFetch(`/AvailablePhoneNumbers/US/Local.json?${params}`);
  return (json.available_phone_numbers ?? []).map((n: any) => ({
    e164: n.phone_number,
    friendly: n.friendly_name,
    locality: n.locality ?? undefined,
    region: n.region ?? undefined,
  }));
}

export function voiceWebhookUrl(): string {
  const base = config.publicUrl.replace(/\/$/, "");
  return `${base}/twilio/voice`;
}

/** Buy a number and point its voice webhook at us. Returns {sid, e164}. */
export async function purchaseNumber(e164: string): Promise<{ sid: string; e164: string }> {
  if (!config.publicUrl) {
    throw new Error("PUBLIC_URL must be set (your https tunnel/host) before provisioning numbers.");
  }
  const json = await twilioFetch("/IncomingPhoneNumbers.json", {
    method: "POST",
    form: {
      PhoneNumber: e164,
      VoiceUrl: voiceWebhookUrl(),
      VoiceMethod: "POST",
    },
  });
  return { sid: json.sid, e164: json.phone_number };
}

/** Point an already-owned number's voice webhook at us. */
export async function configureNumber(numberSid: string): Promise<void> {
  if (!config.publicUrl) {
    throw new Error("PUBLIC_URL must be set before configuring numbers.");
  }
  await twilioFetch(`/IncomingPhoneNumbers/${numberSid}.json`, {
    method: "POST",
    form: { VoiceUrl: voiceWebhookUrl(), VoiceMethod: "POST" },
  });
}

export async function listOwnedNumbers(): Promise<Array<{ sid: string; e164: string; voiceUrl: string }>> {
  const json = await twilioFetch("/IncomingPhoneNumbers.json?PageSize=50");
  return (json.incoming_phone_numbers ?? []).map((n: any) => ({
    sid: n.sid,
    e164: n.phone_number,
    voiceUrl: n.voice_url ?? "",
  }));
}

export async function releaseNumber(numberSid: string): Promise<void> {
  await twilioFetch(`/IncomingPhoneNumbers/${numberSid}.json`, { method: "DELETE" });
}

/** Replace the live call's TwiML with a <Dial> to a human. */
export async function transferCall(callSid: string, to: string): Promise<void> {
  const twiml = `<Response><Say voice="Polly.Joanna">Connecting you now.</Say><Dial>${escapeXml(to)}</Dial></Response>`;
  await twilioFetch(`/Calls/${callSid}.json`, { method: "POST", form: { Twiml: twiml } });
}

export async function hangupCall(callSid: string): Promise<void> {
  await twilioFetch(`/Calls/${callSid}.json`, { method: "POST", form: { Status: "completed" } });
}

/** Send an SMS. `from` must be an SMS-capable number owned by the account. */
export async function sendSms(from: string, to: string, body: string): Promise<void> {
  await twilioFetch("/Messages.json", { method: "POST", form: { From: from, To: to, Body: body } });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
