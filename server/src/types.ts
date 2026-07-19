/** Shared domain types for CallCatcher. */

export interface DayHours {
  /** "closed" or e.g. "09:00-17:00". Split shifts: "09:00-12:00,13:00-17:00" */
  open: boolean;
  ranges: Array<{ start: string; end: string }>;
}

export type WeekHours = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  DayHours
>;

export interface Service {
  name: string;
  description?: string;
  price?: string;
  durationMin?: number;
}

export interface Faq {
  question: string;
  answer: string;
}

/** An agency account. Every dashboard user belongs to exactly one tenant. */
export interface TenantRecord {
  id: string;
  name: string;
  /** Plan id from plans.ts: trial | starter | pro | scale | dev */
  plan: string;
  /** active | past_due | canceled | trial_expired | suspended */
  planStatus: string;
  trialEndsAt?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: string;
  twilioSubaccountSid?: string;
  /** AES-256-GCM ciphertext of the subaccount auth token (SECRETS_KEY). */
  twilioSubaccountTokenEnc?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord {
  /** Supabase auth user id (sub claim); "dev"/"ops" for the non-supabase contexts. */
  id: string;
  tenantId: string;
  email: string;
  role: "owner" | "member";
  platformAdmin: boolean;
  createdAt: string;
}

export interface BusinessProfile {
  id: string;
  /** Owning tenant. null = legacy row from before multi-tenancy (visible to platform admins). */
  tenantId: string | null;
  name: string;
  industry: string;
  description: string;
  timezone: string;
  address?: string;
  website?: string;
  email?: string;
  /** Number where a human can be reached for transfers. E.164. */
  forwardNumber?: string;
  /** Text captured messages/appointments to the client. Default on. */
  notifySms?: boolean;
  /** Where notifications go, if different from the forward number. Falls back to forwardNumber. */
  notifyNumber?: string;
  hours: WeekHours;
  services: Service[];
  faqs: Faq[];
  /** Freeform policies: parking, cancellations, insurance, payment methods... */
  policies: string;
  /** Anything else the receptionist should know. */
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceConfig {
  /** TTS provider id: "deepgram" | "elevenlabs" | "mock" */
  provider: string;
  /** Provider-specific voice id, e.g. "aura-2-thalia-en" */
  voiceId: string;
}

export interface LlmConfig {
  /** "anthropic" | "openai" | "mock" */
  provider: string;
  model: string;
  maxTokens: number;
}

export interface ReceptionistConfig {
  id: string;
  businessId: string;
  version: number;
  active: boolean;
  /** Compiled system prompt (may include {{NOW}} style placeholders resolved per call). */
  systemPrompt: string;
  greeting: string;
  personality: "friendly" | "professional" | "warm" | "efficient";
  voice: VoiceConfig;
  llm: LlmConfig;
  sttProvider: string;
  /** Enabled tool names. */
  tools: string[];
  /** Max call duration in seconds before polite wrap-up. */
  maxCallSeconds: number;
  createdAt: string;
}

export interface PhoneNumberRecord {
  businessId: string;
  e164: string;
  twilioSid?: string;
  status: "pending" | "active" | "manual";
}

export type CallStatus = "in-progress" | "completed" | "failed";

export interface CallRecord {
  id: string;
  businessId: string;
  channel: "phone" | "web" | "chat";
  twilioCallSid?: string;
  fromNumber?: string;
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  status: CallStatus;
  endedReason?: string;
  /** JSON metrics: per-turn latency, token usage, estimated cost. */
  metrics?: CallMetrics;
}

export interface TurnLatency {
  sttFinalMs?: number;
  llmFirstTokenMs?: number;
  ttsFirstAudioMs?: number;
  totalMs?: number;
}

export interface CallMetrics {
  turns: number;
  interruptions: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmCacheReadTokens: number;
  ttsChars: number;
  sttSeconds: number;
  avgResponseMs?: number;
  estimatedCostUsd?: number;
}

export interface TranscriptTurn {
  id: string;
  callId: string;
  role: "assistant" | "user" | "tool" | "system";
  content: string;
  at: string;
  /** True if the assistant was cut off by barge-in. */
  truncated?: boolean;
  latency?: TurnLatency;
}

export interface MessageRecord {
  id: string;
  businessId: string;
  callId?: string;
  callerName?: string;
  callbackNumber?: string;
  content: string;
  urgency: "normal" | "urgent";
  status: "new" | "handled";
  createdAt: string;
}

export interface AppointmentRequest {
  id: string;
  businessId: string;
  callId?: string;
  name?: string;
  phone?: string;
  service?: string;
  preferredTimes?: string;
  notes?: string;
  status: "new" | "confirmed" | "declined";
  createdAt: string;
}

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function defaultHours(): WeekHours {
  const weekday: DayHours = { open: true, ranges: [{ start: "09:00", end: "17:00" }] };
  const closed: DayHours = { open: false, ranges: [] };
  return {
    mon: { ...weekday, ranges: [...weekday.ranges] },
    tue: { ...weekday, ranges: [...weekday.ranges] },
    wed: { ...weekday, ranges: [...weekday.ranges] },
    thu: { ...weekday, ranges: [...weekday.ranges] },
    fri: { ...weekday, ranges: [...weekday.ranges] },
    sat: closed,
    sun: { ...closed, ranges: [] },
  };
}
