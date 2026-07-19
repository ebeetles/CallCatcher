import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.ts";
import type {
  AppointmentRequest,
  BusinessProfile,
  CallMetrics,
  CallRecord,
  MessageRecord,
  PhoneNumberRecord,
  ReceptionistConfig,
  TenantRecord,
  TranscriptTurn,
  TurnLatency,
  UserRecord,
} from "./types.ts";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  plan_status TEXT NOT NULL DEFAULT 'active',
  trial_ends_at TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end TEXT,
  twilio_subaccount_sid TEXT,
  twilio_subaccount_token_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  platform_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS usage_monthly (
  tenant_id TEXT NOT NULL,
  month TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  address TEXT,
  website TEXT,
  email TEXT,
  forward_number TEXT,
  notify_sms INTEGER NOT NULL DEFAULT 1,
  notify_number TEXT,
  hours_json TEXT NOT NULL,
  services_json TEXT NOT NULL DEFAULT '[]',
  faqs_json TEXT NOT NULL DEFAULT '[]',
  policies TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receptionists (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  system_prompt TEXT NOT NULL,
  greeting TEXT NOT NULL,
  personality TEXT NOT NULL DEFAULT 'friendly',
  voice_json TEXT NOT NULL,
  llm_json TEXT NOT NULL,
  stt_provider TEXT NOT NULL DEFAULT 'deepgram',
  tools_json TEXT NOT NULL DEFAULT '[]',
  max_call_seconds INTEGER NOT NULL DEFAULT 600,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receptionists_business ON receptionists(business_id, active);

CREATE TABLE IF NOT EXISTS phone_numbers (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  e164 TEXT NOT NULL UNIQUE,
  twilio_sid TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'phone',
  twilio_call_sid TEXT,
  from_number TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'in-progress',
  ended_reason TEXT,
  metrics_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_business ON calls(business_id, started_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  at TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  latency_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_call ON turns(call_id, at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id TEXT,
  caller_name TEXT,
  callback_number TEXT,
  content TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_business ON messages(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id TEXT,
  name TEXT,
  phone TEXT,
  service TEXT,
  preferred_times TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_business ON appointments(business_id, created_at DESC);
`);

// Idempotent column adds for schemas created before these columns existed.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("businesses", "notify_sms", "notify_sms INTEGER NOT NULL DEFAULT 1");
ensureColumn("businesses", "notify_number", "notify_number TEXT");
// NULL tenant_id = legacy row from before multi-tenancy; adopted at admin signup.
ensureColumn("businesses", "tenant_id", "tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE");
db.exec("CREATE INDEX IF NOT EXISTS idx_businesses_tenant ON businesses(tenant_id)");

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

const nowIso = () => new Date().toISOString();

// ---------- Tenants & users ----------

function rowToTenant(r: any): TenantRecord {
  return {
    id: r.id,
    name: r.name,
    plan: r.plan,
    planStatus: r.plan_status,
    trialEndsAt: r.trial_ends_at ?? undefined,
    stripeCustomerId: r.stripe_customer_id ?? undefined,
    stripeSubscriptionId: r.stripe_subscription_id ?? undefined,
    currentPeriodEnd: r.current_period_end ?? undefined,
    twilioSubaccountSid: r.twilio_subaccount_sid ?? undefined,
    twilioSubaccountTokenEnc: r.twilio_subaccount_token_enc ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const TENANT_COLS: Record<string, string> = {
  name: "name",
  plan: "plan",
  planStatus: "plan_status",
  trialEndsAt: "trial_ends_at",
  stripeCustomerId: "stripe_customer_id",
  stripeSubscriptionId: "stripe_subscription_id",
  currentPeriodEnd: "current_period_end",
  twilioSubaccountSid: "twilio_subaccount_sid",
  twilioSubaccountTokenEnc: "twilio_subaccount_token_enc",
};

export const tenants = {
  create(input: { id?: string; name: string; plan?: string; trialEndsAt?: string }): TenantRecord {
    const id = input.id ?? newId("tnt");
    const now = nowIso();
    db.prepare(
      `INSERT INTO tenants (id,name,plan,plan_status,trial_ends_at,created_at,updated_at)
       VALUES (?,?,?,'active',?,?,?)`
    ).run(id, input.name, input.plan ?? "trial", input.trialEndsAt ?? null, now, now);
    return this.get(id)!;
  },

  get(id: string): TenantRecord | undefined {
    const r = db.prepare("SELECT * FROM tenants WHERE id=?").get(id);
    return r ? rowToTenant(r) : undefined;
  },

  byStripeCustomer(customerId: string): TenantRecord | undefined {
    const r = db.prepare("SELECT * FROM tenants WHERE stripe_customer_id=?").get(customerId);
    return r ? rowToTenant(r) : undefined;
  },

  update(id: string, patch: Partial<Omit<TenantRecord, "id" | "createdAt" | "updatedAt">>): TenantRecord | undefined {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, col] of Object.entries(TENANT_COLS)) {
      if (key in patch) {
        sets.push(`${col}=?`);
        vals.push((patch as any)[key] ?? null);
      }
    }
    if (sets.length) {
      db.prepare(`UPDATE tenants SET ${sets.join(",")}, updated_at=? WHERE id=?`).run(...vals, nowIso(), id);
    }
    return this.get(id);
  },

  list(): TenantRecord[] {
    return db.prepare("SELECT * FROM tenants ORDER BY created_at DESC").all().map(rowToTenant);
  },

  /** Claim legacy (pre-tenancy) businesses for this tenant. Returns count adopted. */
  adoptOrphanBusinesses(tenantId: string): number {
    return db.prepare("UPDATE businesses SET tenant_id=? WHERE tenant_id IS NULL").run(tenantId).changes;
  },
};

export const users = {
  create(input: { id: string; tenantId: string; email: string; role?: UserRecord["role"]; platformAdmin?: boolean }): UserRecord {
    db.prepare(
      `INSERT INTO users (id,tenant_id,email,role,platform_admin,created_at) VALUES (?,?,?,?,?,?)`
    ).run(input.id, input.tenantId, input.email, input.role ?? "owner", input.platformAdmin ? 1 : 0, nowIso());
    return this.get(input.id)!;
  },

  get(id: string): UserRecord | undefined {
    const r = db.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
    return r
      ? {
          id: r.id,
          tenantId: r.tenant_id,
          email: r.email,
          role: r.role,
          platformAdmin: !!r.platform_admin,
          createdAt: r.created_at,
        }
      : undefined;
  },
};

// ---------- Businesses ----------

function rowToBusiness(r: any): BusinessProfile {
  return {
    id: r.id,
    tenantId: r.tenant_id ?? null,
    name: r.name,
    industry: r.industry,
    description: r.description,
    timezone: r.timezone,
    address: r.address ?? undefined,
    website: r.website ?? undefined,
    email: r.email ?? undefined,
    forwardNumber: r.forward_number ?? undefined,
    notifySms: r.notify_sms == null ? true : !!r.notify_sms,
    notifyNumber: r.notify_number ?? undefined,
    hours: JSON.parse(r.hours_json),
    services: JSON.parse(r.services_json),
    faqs: JSON.parse(r.faqs_json),
    policies: r.policies,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type BusinessInput = Omit<BusinessProfile, "id" | "tenantId" | "createdAt" | "updatedAt">;

/**
 * Tenant visibility filter: a tenant sees its own rows; platform admins (ops
 * token, dev mode, ADMIN_EMAILS users) additionally see legacy NULL-tenant rows.
 */
export interface TenantScope {
  tenantId: string;
  includeOrphans?: boolean;
}

function scopeWhere(alias: string, scope: TenantScope): { sql: string; params: unknown[] } {
  return scope.includeOrphans
    ? { sql: `(${alias}.tenant_id = ? OR ${alias}.tenant_id IS NULL)`, params: [scope.tenantId] }
    : { sql: `${alias}.tenant_id = ?`, params: [scope.tenantId] };
}

export const businesses = {
  create(input: BusinessInput, tenantId: string | null): BusinessProfile {
    const id = newId("biz");
    const now = nowIso();
    db.prepare(
      `INSERT INTO businesses (id,tenant_id,name,industry,description,timezone,address,website,email,forward_number,notify_sms,notify_number,hours_json,services_json,faqs_json,policies,notes,created_at,updated_at)
       VALUES (@id,@tenant_id,@name,@industry,@description,@timezone,@address,@website,@email,@forward_number,@notify_sms,@notify_number,@hours_json,@services_json,@faqs_json,@policies,@notes,@created_at,@updated_at)`
    ).run({
      id,
      tenant_id: tenantId,
      name: input.name,
      industry: input.industry,
      description: input.description,
      timezone: input.timezone,
      address: input.address ?? null,
      website: input.website ?? null,
      email: input.email ?? null,
      forward_number: input.forwardNumber ?? null,
      notify_sms: input.notifySms === false ? 0 : 1,
      notify_number: input.notifyNumber ?? null,
      hours_json: JSON.stringify(input.hours),
      services_json: JSON.stringify(input.services),
      faqs_json: JSON.stringify(input.faqs),
      policies: input.policies,
      notes: input.notes,
      created_at: now,
      updated_at: now,
    });
    return this.get(id)!;
  },

  update(id: string, input: Partial<BusinessInput>): BusinessProfile | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const merged = { ...cur, ...input };
    db.prepare(
      `UPDATE businesses SET name=@name,industry=@industry,description=@description,timezone=@timezone,address=@address,website=@website,email=@email,forward_number=@forward_number,notify_sms=@notify_sms,notify_number=@notify_number,hours_json=@hours_json,services_json=@services_json,faqs_json=@faqs_json,policies=@policies,notes=@notes,updated_at=@updated_at WHERE id=@id`
    ).run({
      id,
      name: merged.name,
      industry: merged.industry,
      description: merged.description,
      timezone: merged.timezone,
      address: merged.address ?? null,
      website: merged.website ?? null,
      email: merged.email ?? null,
      forward_number: merged.forwardNumber ?? null,
      notify_sms: merged.notifySms === false ? 0 : 1,
      notify_number: merged.notifyNumber ?? null,
      hours_json: JSON.stringify(merged.hours),
      services_json: JSON.stringify(merged.services),
      faqs_json: JSON.stringify(merged.faqs),
      policies: merged.policies,
      notes: merged.notes,
      updated_at: nowIso(),
    });
    return this.get(id);
  },

  get(id: string): BusinessProfile | undefined {
    const r = db.prepare("SELECT * FROM businesses WHERE id=?").get(id);
    return r ? rowToBusiness(r) : undefined;
  },

  /** get(), but only if the row is visible to this tenant scope. */
  getScoped(id: string, scope: TenantScope): BusinessProfile | undefined {
    const w = scopeWhere("businesses", scope);
    const r = db.prepare(`SELECT * FROM businesses WHERE id=? AND ${w.sql}`).get(id, ...w.params);
    return r ? rowToBusiness(r) : undefined;
  },

  list(scope: TenantScope): BusinessProfile[] {
    const w = scopeWhere("businesses", scope);
    return db
      .prepare(`SELECT * FROM businesses WHERE ${w.sql} ORDER BY created_at DESC`)
      .all(...w.params)
      .map(rowToBusiness);
  },

  countForTenant(tenantId: string): number {
    const r = db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE tenant_id=?").get(tenantId) as any;
    return r.n;
  },

  delete(id: string): void {
    db.prepare("DELETE FROM businesses WHERE id=?").run(id);
  },
};

// ---------- Receptionists ----------

function rowToReceptionist(r: any): ReceptionistConfig {
  return {
    id: r.id,
    businessId: r.business_id,
    version: r.version,
    active: !!r.active,
    systemPrompt: r.system_prompt,
    greeting: r.greeting,
    personality: r.personality,
    voice: JSON.parse(r.voice_json),
    llm: JSON.parse(r.llm_json),
    sttProvider: r.stt_provider,
    tools: JSON.parse(r.tools_json),
    maxCallSeconds: r.max_call_seconds,
    createdAt: r.created_at,
  };
}

export type ReceptionistInput = Omit<ReceptionistConfig, "id" | "version" | "active" | "createdAt">;

export const receptionists = {
  /** Creates a new version and marks it active (previous versions deactivated). */
  create(input: ReceptionistInput): ReceptionistConfig {
    const id = newId("rcp");
    const prev = db
      .prepare("SELECT MAX(version) AS v FROM receptionists WHERE business_id=?")
      .get(input.businessId) as { v: number | null };
    const version = (prev.v ?? 0) + 1;
    const tx = db.transaction(() => {
      db.prepare("UPDATE receptionists SET active=0 WHERE business_id=?").run(input.businessId);
      db.prepare(
        `INSERT INTO receptionists (id,business_id,version,active,system_prompt,greeting,personality,voice_json,llm_json,stt_provider,tools_json,max_call_seconds,created_at)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        input.businessId,
        version,
        input.systemPrompt,
        input.greeting,
        input.personality,
        JSON.stringify(input.voice),
        JSON.stringify(input.llm),
        input.sttProvider,
        JSON.stringify(input.tools),
        input.maxCallSeconds,
        nowIso()
      );
    });
    tx();
    return this.get(id)!;
  },

  get(id: string): ReceptionistConfig | undefined {
    const r = db.prepare("SELECT * FROM receptionists WHERE id=?").get(id);
    return r ? rowToReceptionist(r) : undefined;
  },

  activeForBusiness(businessId: string): ReceptionistConfig | undefined {
    const r = db
      .prepare("SELECT * FROM receptionists WHERE business_id=? AND active=1 ORDER BY version DESC LIMIT 1")
      .get(businessId);
    return r ? rowToReceptionist(r) : undefined;
  },

  listForBusiness(businessId: string): ReceptionistConfig[] {
    return db
      .prepare("SELECT * FROM receptionists WHERE business_id=? ORDER BY version DESC")
      .all(businessId)
      .map(rowToReceptionist);
  },
};

// ---------- Phone numbers ----------

export const phoneNumbers = {
  upsert(rec: PhoneNumberRecord): void {
    db.prepare(
      `INSERT INTO phone_numbers (business_id,e164,twilio_sid,status) VALUES (@business_id,@e164,@twilio_sid,@status)
       ON CONFLICT(business_id) DO UPDATE SET e164=@e164, twilio_sid=@twilio_sid, status=@status`
    ).run({
      business_id: rec.businessId,
      e164: rec.e164,
      twilio_sid: rec.twilioSid ?? null,
      status: rec.status,
    });
  },
  forBusiness(businessId: string): PhoneNumberRecord | undefined {
    const r = db.prepare("SELECT * FROM phone_numbers WHERE business_id=?").get(businessId) as any;
    return r
      ? { businessId: r.business_id, e164: r.e164, twilioSid: r.twilio_sid ?? undefined, status: r.status }
      : undefined;
  },
  byE164(e164: string): PhoneNumberRecord | undefined {
    const r = db.prepare("SELECT * FROM phone_numbers WHERE e164=?").get(e164) as any;
    return r
      ? { businessId: r.business_id, e164: r.e164, twilioSid: r.twilio_sid ?? undefined, status: r.status }
      : undefined;
  },
  delete(businessId: string): void {
    db.prepare("DELETE FROM phone_numbers WHERE business_id=?").run(businessId);
  },
};

// ---------- Calls & transcripts ----------

function rowToCall(r: any): CallRecord {
  return {
    id: r.id,
    businessId: r.business_id,
    channel: r.channel,
    twilioCallSid: r.twilio_call_sid ?? undefined,
    fromNumber: r.from_number ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    durationSec: r.duration_sec ?? undefined,
    status: r.status,
    endedReason: r.ended_reason ?? undefined,
    metrics: r.metrics_json ? (JSON.parse(r.metrics_json) as CallMetrics) : undefined,
  };
}

export const calls = {
  create(businessId: string, channel: CallRecord["channel"], twilioCallSid?: string, fromNumber?: string): CallRecord {
    const id = newId("call");
    db.prepare(
      `INSERT INTO calls (id,business_id,channel,twilio_call_sid,from_number,started_at,status) VALUES (?,?,?,?,?,?,'in-progress')`
    ).run(id, businessId, channel, twilioCallSid ?? null, fromNumber ?? null, nowIso());
    return this.get(id)!;
  },
  end(id: string, reason: string, metrics?: CallMetrics): void {
    const cur = this.get(id);
    if (!cur) return;
    const ended = new Date();
    const dur = Math.round((ended.getTime() - new Date(cur.startedAt).getTime()) / 1000);
    db.prepare(
      `UPDATE calls SET ended_at=?, duration_sec=?, status='completed', ended_reason=?, metrics_json=? WHERE id=?`
    ).run(ended.toISOString(), dur, reason, metrics ? JSON.stringify(metrics) : null, id);
    // Meter the tenant's monthly usage (survives business deletion — billing record).
    const owner = db
      .prepare("SELECT b.tenant_id AS t FROM calls c JOIN businesses b ON b.id=c.business_id WHERE c.id=?")
      .get(id) as { t: string | null } | undefined;
    if (owner?.t) usage.record(owner.t, dur, metrics?.estimatedCostUsd ?? 0);
  },
  get(id: string): CallRecord | undefined {
    const r = db.prepare("SELECT * FROM calls WHERE id=?").get(id);
    return r ? rowToCall(r) : undefined;
  },
  /** get(), but only if the owning business is visible to this tenant scope. */
  getScoped(id: string, scope: TenantScope): CallRecord | undefined {
    const w = scopeWhere("b", scope);
    const r = db
      .prepare(`SELECT c.* FROM calls c JOIN businesses b ON b.id=c.business_id WHERE c.id=? AND ${w.sql}`)
      .get(id, ...w.params);
    return r ? rowToCall(r) : undefined;
  },
  listForBusiness(businessId: string, limit = 100): CallRecord[] {
    return db
      .prepare("SELECT * FROM calls WHERE business_id=? ORDER BY started_at DESC LIMIT ?")
      .all(businessId, limit)
      .map(rowToCall);
  },
  statsForBusiness(businessId: string): { total: number; today: number; totalMinutes: number } {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN started_at >= date('now') THEN 1 ELSE 0 END) AS today,
                COALESCE(SUM(duration_sec),0) AS secs
         FROM calls WHERE business_id=?`
      )
      .get(businessId) as any;
    return { total: r.total, today: r.today ?? 0, totalMinutes: Math.round((r.secs ?? 0) / 60) };
  },
};

// ---------- usage metering ----------

/** Current calendar month as 'YYYY-MM' (UTC). */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export const usage = {
  record(tenantId: string, seconds: number, estCostUsd: number, month = currentMonth()): void {
    db.prepare(
      `INSERT INTO usage_monthly (tenant_id, month, calls, seconds, est_cost_usd) VALUES (?,?,1,?,?)
       ON CONFLICT(tenant_id, month) DO UPDATE SET
         calls = calls + 1, seconds = seconds + excluded.seconds, est_cost_usd = est_cost_usd + excluded.est_cost_usd`
    ).run(tenantId, month, seconds, estCostUsd);
  },

  month(tenantId: string, month = currentMonth()): { calls: number; seconds: number; estCostUsd: number } {
    const r = db
      .prepare("SELECT calls, seconds, est_cost_usd AS estCostUsd FROM usage_monthly WHERE tenant_id=? AND month=?")
      .get(tenantId, month) as any;
    return r ?? { calls: 0, seconds: 0, estCostUsd: 0 };
  },

  /** Per-business breakdown for the month, from the calls table (live view). */
  perBusinessMonth(tenantId: string, month = currentMonth()): Array<{ businessId: string; name: string; calls: number; seconds: number }> {
    return db
      .prepare(
        `SELECT b.id AS businessId, b.name AS name, COUNT(c.id) AS calls, COALESCE(SUM(c.duration_sec),0) AS seconds
         FROM businesses b LEFT JOIN calls c ON c.business_id = b.id AND substr(c.started_at,1,7) = ?
         WHERE b.tenant_id = ?
         GROUP BY b.id ORDER BY seconds DESC`
      )
      .all(month, tenantId) as any;
  },
};

export const turns = {
  add(callId: string, role: TranscriptTurn["role"], content: string, opts?: { truncated?: boolean; latency?: TurnLatency }): TranscriptTurn {
    const id = newId("turn");
    const at = nowIso();
    db.prepare(
      `INSERT INTO turns (id,call_id,role,content,at,truncated,latency_json) VALUES (?,?,?,?,?,?,?)`
    ).run(id, callId, role, content, at, opts?.truncated ? 1 : 0, opts?.latency ? JSON.stringify(opts.latency) : null);
    return { id, callId, role, content, at, truncated: opts?.truncated, latency: opts?.latency };
  },
  forCall(callId: string): TranscriptTurn[] {
    return db
      .prepare("SELECT * FROM turns WHERE call_id=? ORDER BY at ASC, rowid ASC")
      .all(callId)
      .map((r: any) => ({
        id: r.id,
        callId: r.call_id,
        role: r.role,
        content: r.content,
        at: r.at,
        truncated: !!r.truncated,
        latency: r.latency_json ? JSON.parse(r.latency_json) : undefined,
      }));
  },
};

// ---------- Messages & appointments ----------

export const messages = {
  create(input: Omit<MessageRecord, "id" | "createdAt" | "status"> & { status?: MessageRecord["status"] }): MessageRecord {
    const id = newId("msg");
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO messages (id,business_id,call_id,caller_name,callback_number,content,urgency,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      input.businessId,
      input.callId ?? null,
      input.callerName ?? null,
      input.callbackNumber ?? null,
      input.content,
      input.urgency,
      input.status ?? "new",
      createdAt
    );
    return { ...input, id, createdAt, status: input.status ?? "new" };
  },
  listForBusiness(businessId: string): MessageRecord[] {
    return db
      .prepare("SELECT * FROM messages WHERE business_id=? ORDER BY created_at DESC")
      .all(businessId)
      .map((r: any) => ({
        id: r.id,
        businessId: r.business_id,
        callId: r.call_id ?? undefined,
        callerName: r.caller_name ?? undefined,
        callbackNumber: r.callback_number ?? undefined,
        content: r.content,
        urgency: r.urgency,
        status: r.status,
        createdAt: r.created_at,
      }));
  },
  setStatus(id: string, status: MessageRecord["status"]): void {
    db.prepare("UPDATE messages SET status=? WHERE id=?").run(status, id);
  },
  /** True if the message's owning business is visible to this tenant scope. */
  isScoped(id: string, scope: TenantScope): boolean {
    const w = scopeWhere("b", scope);
    return !!db
      .prepare(`SELECT 1 FROM messages m JOIN businesses b ON b.id=m.business_id WHERE m.id=? AND ${w.sql}`)
      .get(id, ...w.params);
  },
};

export const appointments = {
  create(input: Omit<AppointmentRequest, "id" | "createdAt" | "status"> & { status?: AppointmentRequest["status"] }): AppointmentRequest {
    const id = newId("appt");
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO appointments (id,business_id,call_id,name,phone,service,preferred_times,notes,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      input.businessId,
      input.callId ?? null,
      input.name ?? null,
      input.phone ?? null,
      input.service ?? null,
      input.preferredTimes ?? null,
      input.notes ?? null,
      input.status ?? "new",
      createdAt
    );
    return { ...input, id, createdAt, status: input.status ?? "new" };
  },
  listForBusiness(businessId: string): AppointmentRequest[] {
    return db
      .prepare("SELECT * FROM appointments WHERE business_id=? ORDER BY created_at DESC")
      .all(businessId)
      .map((r: any) => ({
        id: r.id,
        businessId: r.business_id,
        callId: r.call_id ?? undefined,
        name: r.name ?? undefined,
        phone: r.phone ?? undefined,
        service: r.service ?? undefined,
        preferredTimes: r.preferred_times ?? undefined,
        notes: r.notes ?? undefined,
        status: r.status,
        createdAt: r.created_at,
      }));
  },
  setStatus(id: string, status: AppointmentRequest["status"]): void {
    db.prepare("UPDATE appointments SET status=? WHERE id=?").run(status, id);
  },
  /** True if the appointment's owning business is visible to this tenant scope. */
  isScoped(id: string, scope: TenantScope): boolean {
    const w = scopeWhere("b", scope);
    return !!db
      .prepare(`SELECT 1 FROM appointments a JOIN businesses b ON b.id=a.business_id WHERE a.id=? AND ${w.sql}`)
      .get(id, ...w.params);
  },
};
