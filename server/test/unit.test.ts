import { describe, expect, it } from "vitest";
import { SentenceChunker } from "../src/voice/sentenceChunker.ts";
import { linearToMulawSample, mulawToLinearSample, mulawTone, pcm16ToMulaw, mulawToPcm16 } from "../src/audio/mulaw.ts";
import { buildSystemPrompt, formatWeekHours, isOpenAt, nowContext, resolveSystemPrompt, to12h } from "../src/promptFactory.ts";
import { estimateCallCost, estimateMonthly } from "../src/costs.ts";
import { defaultHours, type BusinessProfile } from "../src/types.ts";

function fakeBusiness(): BusinessProfile {
  return {
    id: "biz_test",
    tenantId: "tnt_test",
    name: "Testly Spa",
    industry: "day spa",
    description: "A relaxing day spa.",
    timezone: "America/Los_Angeles",
    address: "1 Main St",
    forwardNumber: "+15550001111",
    hours: defaultHours(),
    services: [{ name: "Massage", price: "$90", durationMin: 60 }],
    faqs: [{ question: "Do you take walk-ins?", answer: "Yes, when space allows." }],
    policies: "Cancel 24 hours ahead.",
    notes: "",
    createdAt: "",
    updatedAt: "",
  };
}

describe("sentence chunker", () => {
  it("splits on sentence boundaries as text streams in", () => {
    const c = new SentenceChunker();
    const segs: string[] = [];
    for (const delta of ["Hello there! We open", " at nine. Would you like", " to book?"]) {
      segs.push(...c.push(delta));
    }
    const rest = c.flush();
    expect(segs).toEqual(["Hello there!", "We open at nine."]);
    expect(rest).toBe("Would you like to book?");
  });

  it("does not split abbreviations or decimals", () => {
    const c = new SentenceChunker();
    const segs = c.push("Dr. Chen charges $4.50 for coffee. Really.");
    expect(segs[0]).toBe("Dr. Chen charges $4.50 for coffee.");
  });

  it("soft-splits very long clauses at a comma", () => {
    const c = new SentenceChunker({ softMax: 40 });
    const segs = c.push("we offer massages, facials, and also very long relaxing mud baths for everyone today");
    expect(segs.length).toBeGreaterThan(0);
    expect(segs[0].endsWith(",")).toBe(true);
  });
});

describe("mulaw codec", () => {
  it("round-trips samples within tolerance", () => {
    for (const v of [0, 1000, -1000, 8000, -8000, 30000, -30000]) {
      const enc = linearToMulawSample(v);
      const dec = mulawToLinearSample(enc);
      expect(Math.abs(dec - v)).toBeLessThan(Math.max(64, Math.abs(v) * 0.06));
    }
  });

  it("buffer helpers round-trip", () => {
    const pcm = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 20000), i * 2);
    const round = mulawToPcm16(pcm16ToMulaw(pcm));
    expect(round.length).toBe(pcm.length);
    // correlation check: same sign most of the time
    let agree = 0;
    for (let i = 0; i < 160; i++) {
      if (Math.sign(round.readInt16LE(i * 2)) === Math.sign(pcm.readInt16LE(i * 2))) agree++;
    }
    expect(agree).toBeGreaterThan(150);
  });

  it("generates tones of the right length", () => {
    expect(mulawTone(1000).length).toBe(8000);
  });
});

describe("hours & prompt factory", () => {
  it("formats 12h times", () => {
    expect(to12h("09:00")).toBe("9:00 AM");
    expect(to12h("13:30")).toBe("1:30 PM");
    expect(to12h("00:15")).toBe("12:15 AM");
    expect(to12h("12:00")).toBe("12:00 PM");
  });

  it("groups identical days", () => {
    const text = formatWeekHours(defaultHours());
    expect(text).toContain("Monday through Friday: 9:00 AM to 5:00 PM");
    expect(text).toContain("Saturday through Sunday: Closed");
  });

  it("computes open state in the business timezone", () => {
    const hours = defaultHours();
    // Wednesday 2026-07-15 at 17:30 UTC == 10:30 AM in Los Angeles (open)
    expect(isOpenAt(hours, "America/Los_Angeles", new Date("2026-07-15T17:30:00Z"))).toBe(true);
    // Same instant is 19:30 in Berlin (closed — after 17:00)
    expect(isOpenAt(hours, "Europe/Berlin", new Date("2026-07-15T17:30:00Z"))).toBe(false);
    // Sunday: closed everywhere
    expect(isOpenAt(hours, "America/Los_Angeles", new Date("2026-07-19T18:00:00Z"))).toBe(false);
  });

  it("builds a prompt with business facts and {{NOW}} placeholder", () => {
    const biz = fakeBusiness();
    const prompt = buildSystemPrompt(biz, { personality: "friendly", tools: ["take_message", "end_call"] });
    expect(prompt).toContain("Testly Spa");
    expect(prompt).toContain("{{NOW}}");
    expect(prompt).toContain("Massage — price: $90");
    expect(prompt).toContain("Do you take walk-ins?");
    expect(prompt).toContain("take_message");
    expect(prompt).not.toContain("request_appointment:");
    const resolved = resolveSystemPrompt(prompt, biz, new Date("2026-07-15T17:30:00Z"));
    expect(resolved).not.toContain("{{NOW}}");
    expect(resolved).toContain("currently OPEN");
  });

  it("nowContext reports closed days", () => {
    const ctx = nowContext(fakeBusiness(), new Date("2026-07-19T18:00:00Z"));
    expect(ctx).toContain("CLOSED");
  });
});

describe("cost model", () => {
  it("estimates a typical 3-minute phone call in the expected range", () => {
    const cost = estimateCallCost({
      durationSec: 180,
      channel: "phone",
      sttProvider: "deepgram",
      sttSeconds: 180,
      llmModel: "claude-haiku-4-5",
      llmInputTokens: 20000,
      llmOutputTokens: 700,
      llmCacheReadTokens: 12000,
      ttsProvider: "deepgram",
      ttsChars: 1100,
    });
    expect(cost).toBeGreaterThan(0.05);
    expect(cost).toBeLessThan(0.2);
  });

  it("monthly estimate is dramatically cheaper than managed platforms", () => {
    const est = estimateMonthly({ callsPerDay: 12, avgCallMinutes: 2.5, llmModel: "claude-haiku-4-5", ttsProvider: "deepgram" });
    expect(est.perMinute).toBeLessThan(0.06); // vs $0.12-0.35 on Vapi/Retell
    expect(est.monthlyTotal).toBeGreaterThan(0);
  });
});
