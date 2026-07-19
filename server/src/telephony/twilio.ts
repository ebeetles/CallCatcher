import { config } from "../config.ts";
import { decryptSecret, encryptSecret, secretsConfigured } from "../crypto.ts";
import { tenants } from "../db.ts";
import type { TenantRecord } from "../types.ts";

/**
 * Minimal Twilio REST client (no SDK dependency). Basic-auth'd form posts
 * against the 2010-04-01 API — numbers, call control, subaccounts.
 *
 * Multi-tenancy: the platform's master account (env keys) owns one SUBACCOUNT
 * per paying tenant. Numbers are bought inside the tenant's subaccount, so
 * telephony spend is attributable per tenant, numbers are isolated, and a
 * churned tenant's subaccount can be suspended/closed in one call. The
 * platform's own tenants (plan "dev": ops/dev/admin) run directly on the
 * master account, as do legacy deployments with no subaccounts.
 */

const BASE = "https://api.twilio.com/2010-04-01";

export interface AvailableNumber {
  e164: string;
  friendly: string;
  locality?: string;
  region?: string;
}

async function twilioFetch(
  creds: { sid: string; token: string },
  path: string,
  init?: { method?: string; form?: Record<string, string> }
) {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: "Basic " + Buffer.from(`${creds.sid}:${creds.token}`).toString("base64"),
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

export function voiceWebhookUrl(): string {
  const base = config.publicUrl.replace(/\/$/, "");
  return `${base}/twilio/voice`;
}

/** Account-scoped operations. Works identically for the master account and subaccounts. */
export class TwilioClient {
  constructor(readonly accountSid: string, private readonly authToken: string) {}

  private api(path: string, init?: { method?: string; form?: Record<string, string> }) {
    return twilioFetch({ sid: this.accountSid, token: this.authToken }, `/Accounts/${this.accountSid}${path}`, init);
  }

  async searchNumbers(opts: { areaCode?: string; contains?: string }): Promise<AvailableNumber[]> {
    const params = new URLSearchParams({ VoiceEnabled: "true", PageSize: "12" });
    if (opts.areaCode) params.set("AreaCode", opts.areaCode);
    if (opts.contains) params.set("Contains", opts.contains);
    const json = await this.api(`/AvailablePhoneNumbers/US/Local.json?${params}`);
    return (json.available_phone_numbers ?? []).map((n: any) => ({
      e164: n.phone_number,
      friendly: n.friendly_name,
      locality: n.locality ?? undefined,
      region: n.region ?? undefined,
    }));
  }

  /** Buy a number in this account and point its voice webhook at us. */
  async purchaseNumber(e164: string): Promise<{ sid: string; e164: string }> {
    if (!config.publicUrl) {
      throw new Error("PUBLIC_URL must be set (your https tunnel/host) before provisioning numbers.");
    }
    const json = await this.api("/IncomingPhoneNumbers.json", {
      method: "POST",
      form: { PhoneNumber: e164, VoiceUrl: voiceWebhookUrl(), VoiceMethod: "POST" },
    });
    return { sid: json.sid, e164: json.phone_number };
  }

  /** Point an already-owned number's voice webhook at us. */
  async configureNumber(numberSid: string): Promise<void> {
    if (!config.publicUrl) {
      throw new Error("PUBLIC_URL must be set before configuring numbers.");
    }
    await this.api(`/IncomingPhoneNumbers/${numberSid}.json`, {
      method: "POST",
      form: { VoiceUrl: voiceWebhookUrl(), VoiceMethod: "POST" },
    });
  }

  async listOwnedNumbers(): Promise<Array<{ sid: string; e164: string; voiceUrl: string }>> {
    const json = await this.api("/IncomingPhoneNumbers.json?PageSize=50");
    return (json.incoming_phone_numbers ?? []).map((n: any) => ({
      sid: n.sid,
      e164: n.phone_number,
      voiceUrl: n.voice_url ?? "",
    }));
  }

  async releaseNumber(numberSid: string): Promise<void> {
    await this.api(`/IncomingPhoneNumbers/${numberSid}.json`, { method: "DELETE" });
  }

  /** Replace the live call's TwiML with a <Dial> to a human. */
  async transferCall(callSid: string, to: string): Promise<void> {
    const twiml = `<Response><Say voice="Polly.Joanna">Connecting you now.</Say><Dial>${escapeXml(to)}</Dial></Response>`;
    await this.api(`/Calls/${callSid}.json`, { method: "POST", form: { Twiml: twiml } });
  }

  async hangupCall(callSid: string): Promise<void> {
    await this.api(`/Calls/${callSid}.json`, { method: "POST", form: { Status: "completed" } });
  }

  /** Send an SMS. `from` must be an SMS-capable number owned by this account. */
  async sendSms(from: string, to: string, body: string): Promise<void> {
    await this.api("/Messages.json", { method: "POST", form: { From: from, To: to, Body: body } });
  }
}

// ---------- platform (master) account ----------

export function twilioConfigured(): boolean {
  return !!(config.twilioAccountSid && config.twilioAuthToken);
}

export function platformTwilio(): TwilioClient | undefined {
  return twilioConfigured() ? new TwilioClient(config.twilioAccountSid, config.twilioAuthToken) : undefined;
}

// ---------- per-tenant resolution ----------

/** Decrypted subaccount auth token, or undefined when the tenant runs on the master account. */
export function tenantAuthToken(tenant: TenantRecord | undefined): string | undefined {
  if (!tenant?.twilioSubaccountSid || !tenant.twilioSubaccountTokenEnc) return undefined;
  try {
    return decryptSecret(tenant.twilioSubaccountTokenEnc);
  } catch (err: any) {
    console.error(`[twilio] cannot decrypt subaccount token for ${tenant.id}: ${err?.message ?? err}`);
    return undefined;
  }
}

/**
 * The Twilio client a tenant's numbers/calls/SMS should go through:
 * its subaccount when provisioned, otherwise the master account (legacy
 * deployments, dev/ops tenants, or missing SECRETS_KEY).
 */
export function tenantTwilio(tenant: TenantRecord | undefined): TwilioClient | undefined {
  const token = tenantAuthToken(tenant);
  if (tenant?.twilioSubaccountSid && token) return new TwilioClient(tenant.twilioSubaccountSid, token);
  return platformTwilio();
}

// ---------- subaccount lifecycle (master-account operations) ----------

async function createSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string }> {
  const json = await twilioFetch(
    { sid: config.twilioAccountSid, token: config.twilioAuthToken },
    "/Accounts.json",
    { method: "POST", form: { FriendlyName: friendlyName } }
  );
  return { sid: json.sid, authToken: json.auth_token };
}

export async function setSubaccountStatus(subaccountSid: string, status: "active" | "suspended" | "closed"): Promise<void> {
  await twilioFetch(
    { sid: config.twilioAccountSid, token: config.twilioAuthToken },
    `/Accounts/${subaccountSid}.json`,
    { method: "POST", form: { Status: status } }
  );
}

/**
 * Create the tenant's subaccount if it should have one and doesn't yet.
 * Skipped (with a log) when: platform Twilio keys or SECRETS_KEY are missing,
 * or the tenant is a platform-internal "dev" tenant. Safe to call repeatedly.
 */
export async function ensureTenantSubaccount(tenant: TenantRecord): Promise<TenantRecord> {
  if (tenant.twilioSubaccountSid) return tenant;
  if (tenant.plan === "dev") return tenant;
  if (!twilioConfigured()) return tenant;
  if (!secretsConfigured()) {
    console.warn(`[twilio] SECRETS_KEY not set — tenant ${tenant.id} will use the master Twilio account`);
    return tenant;
  }
  const sub = await createSubaccount(`CallCatcher ${tenant.name} (${tenant.id})`);
  const updated = tenants.update(tenant.id, {
    twilioSubaccountSid: sub.sid,
    twilioSubaccountTokenEnc: encryptSecret(sub.authToken),
  });
  console.log(`[twilio] created subaccount ${sub.sid} for tenant ${tenant.id}`);
  return updated ?? tenant;
}

/** Fire-and-forget wrapper for the tenant-created hook. */
export function provisionTenantSubaccount(tenant: TenantRecord): void {
  void ensureTenantSubaccount(tenant).catch((err: any) => {
    console.error(`[twilio] subaccount creation failed for ${tenant.id}: ${err?.message ?? err}`);
  });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
