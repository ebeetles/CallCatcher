import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppointmentRequest,
  AvailableNumber,
  BusinessInput,
  BusinessSummary,
  CallRecord,
  ChatEvent,
  ExtractedBusiness,
  MessageRecord,
  MonthlyEstimate,
  OwnedNumber,
  PhoneNumberRecord,
  PromptPreview,
  PublicConfig,
  ReceptionistConfig,
  ReceptionistDraft,
  StatusResponse,
  TranscriptTurn,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- auth token ----------
// Every request carries a Bearer token: a Supabase access JWT (supabase mode),
// the ops DASHBOARD_TOKEN (legacy token mode), or nothing (open local dev).
// The AuthProvider swaps in the Supabase getter at startup; the default reads
// the stored dashboard token so token mode works before React mounts.
const TOKEN_KEY = "cc_dashboard_token";
export const getDashboardToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setDashboardToken = (t: string): void => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

let authTokenGetter: () => string | Promise<string> = getDashboardToken;
export function setAuthTokenGetter(fn: () => string | Promise<string>): void {
  authTokenGetter = fn;
}

const authHeaders = async (): Promise<Record<string, string>> => {
  const t = await authTokenGetter();
  return t ? { authorization: `Bearer ${t}` } : {};
};

/** Server 4xx bodies are `{ error: string | zodFlatten }` — reduce either to a sentence. */
function errorText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const flat = err as { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
      const field = Object.entries(flat.fieldErrors ?? {}).find(([, v]) => v?.length);
      if (field) return `${field[0]}: ${field[1][0]}`;
      if (flat.formErrors?.length) return flat.formErrors[0];
    }
  }
  return "Request failed";
}

// API host, when the dashboard is deployed separately from the server (e.g. Vercel + a
// tunneled Beelink). Empty string keeps same-origin requests (local dev via the vite proxy,
// or the server's built-in single-process static serving).
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      // Fastify 400s on a JSON content-type with an empty body, so only set it when there is one.
      headers: {
        ...(await authHeaders()),
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, "Can't reach the server — is it running on port 8787?");
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, errorText(body) || `HTTP ${res.status}`);
  return body as T;
}

const jsonBody = (data: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(data) });

// ---------- meta ----------
export const getPublicConfig = () => api<PublicConfig>("/api/public/config");
export const getStatus = () => api<StatusResponse>("/api/status");
export const getVoices = () => api<Record<string, Array<{ id: string; label: string }>>>("/api/voices");
export const getEstimate = (q: { callsPerDay: number; avgCallMinutes: number; llmModel: string; ttsProvider: string }) =>
  api<MonthlyEstimate>(
    `/api/costs/estimate?callsPerDay=${q.callsPerDay}&avgCallMinutes=${q.avgCallMinutes}&llmModel=${encodeURIComponent(q.llmModel)}&ttsProvider=${encodeURIComponent(q.ttsProvider)}`
  );

// ---------- businesses ----------
export const listBusinesses = () => api<BusinessSummary[]>("/api/businesses");
export const getBusiness = (id: string) => api<BusinessSummary>(`/api/businesses/${id}`);
export const createBusiness = (input: BusinessInput) => api<BusinessSummary>("/api/businesses", jsonBody(input));
export const updateBusiness = (id: string, input: Partial<BusinessInput>) =>
  api<BusinessSummary>(`/api/businesses/${id}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteBusiness = (id: string) => api<{ ok: true }>(`/api/businesses/${id}`, { method: "DELETE" });
export const seedDemo = () => api<BusinessSummary>("/api/seed-demo", { method: "POST" });

// ---------- receptionist factory ----------
export const previewReceptionist = (bizId: string, draft: ReceptionistDraft) =>
  api<PromptPreview>(`/api/businesses/${bizId}/receptionist/preview`, jsonBody(draft));
export const deployReceptionist = (bizId: string, draft: ReceptionistDraft) =>
  api<ReceptionistConfig>(`/api/businesses/${bizId}/receptionist`, jsonBody(draft));
export const listReceptionists = (bizId: string) => api<ReceptionistConfig[]>(`/api/businesses/${bizId}/receptionists`);
export const extractWebsite = (url: string) =>
  api<{ extracted: ExtractedBusiness }>("/api/extract-website", jsonBody({ url }));

// ---------- numbers ----------
export const searchNumbers = (bizId: string, q: { areaCode?: string; contains?: string }) => {
  const params = new URLSearchParams();
  if (q.areaCode) params.set("areaCode", q.areaCode);
  if (q.contains) params.set("contains", q.contains);
  return api<{ numbers: AvailableNumber[] }>(`/api/businesses/${bizId}/number/search?${params}`);
};
export const provisionNumber = (bizId: string, e164: string) =>
  api<{ ok: true; number: PhoneNumberRecord }>(`/api/businesses/${bizId}/number/provision`, jsonBody({ e164 }));
export const attachNumber = (bizId: string, e164: string, twilioSid?: string) =>
  api<{ ok: true; number: PhoneNumberRecord }>(`/api/businesses/${bizId}/number/attach`, jsonBody({ e164, twilioSid }));
export const listOwnedNumbers = () => api<{ numbers: OwnedNumber[] }>("/api/twilio/owned-numbers");
export const detachNumber = (bizId: string) =>
  api<{ ok: true }>(`/api/businesses/${bizId}/number`, { method: "DELETE" });

// ---------- calls ----------
export const listCalls = (bizId: string) => api<CallRecord[]>(`/api/businesses/${bizId}/calls`);
export const getCall = (callId: string) => api<{ call: CallRecord; turns: TranscriptTurn[] }>(`/api/calls/${callId}`);

// ---------- inbox ----------
export const listMessages = (bizId: string) => api<MessageRecord[]>(`/api/businesses/${bizId}/messages`);
export const setMessageStatus = (msgId: string, status: "new" | "handled") =>
  api<{ ok: true }>(`/api/messages/${msgId}`, { method: "PATCH", body: JSON.stringify({ status }) });
export const listAppointments = (bizId: string) => api<AppointmentRequest[]>(`/api/businesses/${bizId}/appointments`);
export const setAppointmentStatus = (apptId: string, status: "new" | "confirmed" | "declined") =>
  api<{ ok: true }>(`/api/appointments/${apptId}`, { method: "PATCH", body: JSON.stringify({ status }) });

// ---------- chat simulator (POST + SSE body) ----------
export async function streamChat(
  bizId: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/businesses/${bizId}/chat`, {
    method: "POST",
    headers: { ...(await authHeaders()), "content-type": "application/json" },
    body: JSON.stringify({ history }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new ApiError(res.status, errorText(body) || `HTTP ${res.status}`);
  }
  if (!res.body) throw new ApiError(0, "No response stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as ChatEvent);
        } catch {
          // skip malformed frame
        }
      }
    }
  }
}

// ---------- hooks ----------
export interface Loaded<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch-on-mount with manual reload. A `deps` change is a hard load (data clears,
 * `loading` goes true); `reload()` revalidates in the background so views keep
 * showing current data — callers can poll without unmounting children.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const key = JSON.stringify(deps);
  const prevKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const hard = prevKey.current !== key;
    prevKey.current = key;
    if (hard) {
      setData(undefined);
      setError(undefined);
      setLoading(true);
    }
    fnRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(undefined);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Quietly re-run `fn` every `ms` while the tab is visible (for live call/inbox views). */
export function usePoll(fn: () => void, ms: number): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") fnRef.current();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms]);
}
