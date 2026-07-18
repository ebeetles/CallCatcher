/**
 * Cost model (USD). Rates checked July 2026 — see docs/costs.md for sources.
 * These feed per-call cost estimates and the dashboard cost calculator.
 */

export const PRICING = {
  telephony: {
    twilioInboundPerMin: 0.0085,
    twilioNumberMonthly: 1.15,
  },
  stt: {
    // Deepgram Nova-3 streaming, pay-as-you-go
    deepgramPerMin: 0.0058,
    mockPerMin: 0,
  } as Record<string, number>,
  tts: {
    // Deepgram Aura-2
    deepgramPer1kChars: 0.03,
    // ElevenLabs Flash v2.5 via API credits (approx)
    elevenlabsPer1kChars: 0.05,
    mockPer1kChars: 0,
  } as Record<string, number>,
  llm: {
    "claude-haiku-4-5": { inPerM: 1.0, outPerM: 5.0, cacheReadPerM: 0.1 },
    "claude-sonnet-4-6": { inPerM: 3.0, outPerM: 15.0, cacheReadPerM: 0.3 },
    "claude-sonnet-5": { inPerM: 3.0, outPerM: 15.0, cacheReadPerM: 0.3 },
    "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6, cacheReadPerM: 0.075 },
    "gpt-4.1-mini": { inPerM: 0.4, outPerM: 1.6, cacheReadPerM: 0.1 },
    mock: { inPerM: 0, outPerM: 0, cacheReadPerM: 0 },
  } as Record<string, { inPerM: number; outPerM: number; cacheReadPerM: number }>,
};

export interface CallCostInput {
  durationSec: number;
  channel: "phone" | "web" | "chat";
  sttProvider: string;
  sttSeconds: number;
  llmModel: string;
  llmInputTokens: number;
  llmOutputTokens: number;
  llmCacheReadTokens: number;
  ttsProvider: string;
  ttsChars: number;
}

export function estimateCallCost(c: CallCostInput): number {
  const telephony = c.channel === "phone" ? (c.durationSec / 60) * PRICING.telephony.twilioInboundPerMin : 0;
  const sttRate = PRICING.stt[`${c.sttProvider}PerMin`] ?? PRICING.stt.deepgramPerMin;
  const stt = (c.sttSeconds / 60) * sttRate;
  const ttsRate = PRICING.tts[`${c.ttsProvider}Per1kChars`] ?? PRICING.tts.deepgramPer1kChars;
  const tts = (c.ttsChars / 1000) * ttsRate;
  const llmRates = PRICING.llm[c.llmModel] ?? PRICING.llm["claude-haiku-4-5"];
  const uncachedIn = Math.max(0, c.llmInputTokens - c.llmCacheReadTokens);
  const llm =
    (uncachedIn / 1e6) * llmRates.inPerM +
    (c.llmCacheReadTokens / 1e6) * llmRates.cacheReadPerM +
    (c.llmOutputTokens / 1e6) * llmRates.outPerM;
  return round4(telephony + stt + tts + llm);
}

export interface MonthlyEstimateInput {
  callsPerDay: number;
  avgCallMinutes: number;
  llmModel: string;
  ttsProvider: string;
}

export function estimateMonthly(input: MonthlyEstimateInput) {
  const minutes = input.callsPerDay * 30 * input.avgCallMinutes;
  // Empirical per-minute assumptions for a typical receptionist call:
  // ~2.5 agent turns/min, ~2.5k input tokens per turn (mostly cached after turn 1),
  // ~90 output tokens per turn, agent speaks ~45% of the call (~380 chars/min).
  const turnsPerMin = 2.5;
  const inTokensPerMin = turnsPerMin * 2500;
  const cachedShare = 0.65;
  const outTokensPerMin = turnsPerMin * 90;
  const ttsCharsPerMin = 380;

  const llmRates = PRICING.llm[input.llmModel] ?? PRICING.llm["claude-haiku-4-5"];
  const llmPerMin =
    ((inTokensPerMin * (1 - cachedShare)) / 1e6) * llmRates.inPerM +
    ((inTokensPerMin * cachedShare) / 1e6) * llmRates.cacheReadPerM +
    (outTokensPerMin / 1e6) * llmRates.outPerM;
  const sttPerMin = PRICING.stt.deepgramPerMin;
  const ttsPerMin = ((ttsCharsPerMin / 1000) * (PRICING.tts[`${input.ttsProvider}Per1kChars`] ?? 0.03));
  const telephonyPerMin = PRICING.telephony.twilioInboundPerMin;

  const perMin = llmPerMin + sttPerMin + ttsPerMin + telephonyPerMin;
  return {
    minutesPerMonth: Math.round(minutes),
    perMinute: round4(perMin),
    breakdown: {
      telephonyPerMin: round4(telephonyPerMin),
      sttPerMin: round4(sttPerMin),
      ttsPerMin: round4(ttsPerMin),
      llmPerMin: round4(llmPerMin),
    },
    monthlyUsage: round2(minutes * perMin),
    monthlyNumber: PRICING.telephony.twilioNumberMonthly,
    monthlyTotal: round2(minutes * perMin + PRICING.telephony.twilioNumberMonthly),
  };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round2 = (n: number) => Math.round(n * 100) / 100;
