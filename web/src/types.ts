/** Frontend mirrors of the server's API types (see server/src/types.ts). */

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export interface DayHours {
  open: boolean;
  ranges: Array<{ start: string; end: string }>;
}
export type WeekHours = Record<DayKey, DayHours>;

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

export interface BusinessProfile {
  id: string;
  name: string;
  industry: string;
  description: string;
  timezone: string;
  address?: string;
  website?: string;
  email?: string;
  forwardNumber?: string;
  notifySms?: boolean;
  notifyNumber?: string;
  hours: WeekHours;
  services: Service[];
  faqs: Faq[];
  policies: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type BusinessInput = Omit<BusinessProfile, "id" | "createdAt" | "updatedAt">;

export interface PhoneNumberRecord {
  businessId: string;
  e164: string;
  twilioSid?: string;
  status: "pending" | "active" | "manual";
}

export interface VoiceConfig {
  provider: string;
  voiceId: string;
}

export interface LlmConfig {
  provider: string;
  model: string;
  maxTokens: number;
}

export type Personality = "friendly" | "professional" | "warm" | "efficient";

export interface ReceptionistConfig {
  id: string;
  businessId: string;
  version: number;
  active: boolean;
  systemPrompt: string;
  greeting: string;
  personality: Personality;
  voice: VoiceConfig;
  llm: LlmConfig;
  sttProvider: string;
  tools: string[];
  maxCallSeconds: number;
  createdAt: string;
}

export interface CallStats {
  total: number;
  today: number;
  totalMinutes: number;
}

export interface BusinessSummary extends BusinessProfile {
  number?: PhoneNumberRecord;
  receptionist?: ReceptionistConfig;
  stats: CallStats;
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
  metrics?: CallMetrics;
}

export interface TurnLatency {
  sttFinalMs?: number;
  llmFirstTokenMs?: number;
  ttsFirstAudioMs?: number;
  totalMs?: number;
}

export interface TranscriptTurn {
  id: string;
  callId: string;
  role: "assistant" | "user" | "tool" | "system";
  content: string;
  at: string;
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

export interface ProviderStatus {
  stt: Record<string, boolean>;
  llm: Record<string, boolean>;
  tts: Record<string, boolean>;
  telephony: { twilio: boolean };
  factoryAi: boolean;
  mockMode: boolean;
}

export interface LlmRate {
  inPerM: number;
  outPerM: number;
  cacheReadPerM: number;
}

export interface Pricing {
  telephony: { twilioInboundPerMin: number; twilioNumberMonthly: number };
  stt: Record<string, number>;
  tts: Record<string, number>;
  llm: Record<string, LlmRate>;
}

export type AuthMode = "supabase" | "token" | "open";

export interface PublicPlan {
  id: string;
  label: string;
  priceUsd: number;
  maxBusinesses: number;
  includedMinutes: number;
  elevenlabs: boolean;
  blurb: string;
}

/** Unauthenticated bootstrap config (GET /api/public/config). */
export interface PublicConfig {
  authMode: AuthMode;
  supabaseUrl: string;
  supabaseAnonKey: string;
  billingEnabled: boolean;
  plans: PublicPlan[];
  /** Built-in landing-page demo receptionist. */
  demo?: { name: string; greeting: string };
}

export interface UsageSummary {
  active: boolean;
  blockedReason?: "trial_expired" | "past_due" | "canceled" | "suspended";
  minutesUsed: number;
  includedMinutes: number | null;
  minutesExhausted: boolean;
  maxBusinesses: number | null;
  trialDaysLeft?: number;
}

export interface AuthInfo {
  mode: AuthMode;
  email: string;
  tenantId: string;
  tenantName: string;
  plan: string;
  planStatus: string;
  trialEndsAt?: string;
  platformAdmin: boolean;
  usage: UsageSummary;
  billing: { enabled: boolean; hasAccount: boolean; currentPeriodEnd?: string };
}

export interface UsageResponse {
  month: string;
  plan: { id: string; label: string; includedMinutes: number | null; maxBusinesses: number | null };
  active: boolean;
  blockedReason?: string;
  trialDaysLeft?: number;
  totals: { calls: number; minutes: number; estCostUsd: number };
  perBusiness: Array<{ businessId: string; name: string; calls: number; minutes: number }>;
}

export interface StatusResponse {
  providers: ProviderStatus;
  defaults: { stt: string; llm: string; tts: string };
  publicUrl: string;
  twilioReady: boolean;
  factoryAi: boolean;
  callModels: { anthropic: string; openai: string };
  pricing: Pricing;
  auth: AuthInfo;
}

export interface MonthlyEstimate {
  minutesPerMonth: number;
  perMinute: number;
  breakdown: {
    telephonyPerMin: number;
    sttPerMin: number;
    ttsPerMin: number;
    llmPerMin: number;
  };
  monthlyUsage: number;
  monthlyNumber: number;
  monthlyTotal: number;
}

export interface AvailableNumber {
  e164: string;
  friendly: string;
  locality?: string;
  region?: string;
}

export interface OwnedNumber {
  sid: string;
  e164: string;
  voiceUrl: string;
}

export interface ReceptionistDraft {
  personality: Personality;
  systemPrompt?: string;
  greeting?: string;
  extraInstructions?: string;
  voice?: VoiceConfig;
  llm?: LlmConfig;
  sttProvider?: string;
  tools?: string[];
  maxCallSeconds?: number;
  useAi?: boolean;
}

export interface PromptPreview {
  systemPrompt: string;
  greeting: string;
  aiRefined: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; summary: string }
  | {
      type: "done";
      endAction?: "end" | "transfer";
      error?: string;
      usage?: LlmUsage;
      firstTokenMs?: number;
    };

export interface ExtractedBusiness {
  name?: string;
  industry?: string;
  description?: string;
  address?: string;
  email?: string;
  services?: Service[];
  faqs?: Faq[];
  policies?: string;
}

export const ALL_TOOLS = ["take_message", "request_appointment", "transfer_call", "end_call"] as const;

export const TOOL_LABELS: Record<string, { label: string; hint: string }> = {
  take_message: { label: "Take messages", hint: "Collects name, callback number, and the message." },
  request_appointment: { label: "Request appointments", hint: "Collects service, preferred times, and contact info." },
  transfer_call: { label: "Transfer to a human", hint: "Forwards the call — needs a forward number on the profile." },
  end_call: { label: "End the call", hint: "Lets the receptionist wrap up and hang up politely." },
};
