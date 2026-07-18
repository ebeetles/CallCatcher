/**
 * End-to-end voice pipeline test: a fake caller speaks the Twilio Media
 * Streams protocol over a real WebSocket against the real server with mock
 * providers (MOCK_PROVIDERS=1). Verifies greeting audio, turn round-trips,
 * tool side-effects (appointment written), assistant hangup, and metrics.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-test-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";

let app: any;
let baseUrl = "";
let businessId = "";

/** fetch + parse; typed as `any` because these are ad-hoc API shapes under test. */
const fetchJson = async (url: string, init?: RequestInit): Promise<any> => {
  const res = await fetch(url, init);
  return res.json();
};

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp({
    sessionTimers: { silencePromptMs: 60000, silenceHangupMs: 60000, playbackGraceMs: 1500 },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  const seeded = await fetchJson(`${baseUrl}/api/seed-demo`, { method: "POST" });
  businessId = seeded.id;
  expect(businessId).toBeTruthy();
});

afterAll(async () => {
  await app?.close();
});

interface FakeCallEvents {
  transcripts: Array<{ role: string; content: string; partial?: boolean }>;
  statuses: Array<Record<string, any>>;
  audioBytes: number;
  closed: Promise<void>;
}

/** Fake caller: speaks Twilio protocol (+ web extensions), echoes marks like Twilio does. */
function connectFakeCall(bizId: string): { ws: WebSocket; events: FakeCallEvents; sendText(t: string): void } {
  const ws = new WebSocket(baseUrl.replace("http", "ws") + "/media-stream");
  let resolveClosed: () => void;
  const events: FakeCallEvents = {
    transcripts: [],
    statuses: [],
    audioBytes: 0,
    closed: new Promise<void>((r) => (resolveClosed = r)),
  };
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        start: {
          streamSid: "MZfake",
          callSid: "CAfake",
          customParameters: { businessId: bizId, web: "1", from: "+15550009999" },
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
        streamSid: "MZfake",
      })
    );
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "media") {
      events.audioBytes += Buffer.from(msg.media.payload, "base64").length;
    } else if (msg.event === "mark") {
      // Twilio echoes marks after buffered audio has played.
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "mark", streamSid: "MZfake", mark: { name: msg.mark.name } }));
        }
      }, 30);
    } else if (msg.event === "transcript") {
      events.transcripts.push(msg);
    } else if (msg.event === "status") {
      events.statuses.push(msg);
    } else if (msg.event === "clear") {
      // barge-in flush; nothing to do client-side in tests
    }
  });
  ws.on("close", () => resolveClosed());
  return {
    ws,
    events,
    sendText(t: string) {
      ws.send(JSON.stringify({ event: "text-input", text: t }));
    },
  };
}

async function waitFor(cond: () => boolean, ms = 8000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("voice pipeline (fake Twilio caller, mock providers)", () => {
  it("plays a greeting, answers questions, books an appointment via tool, and hangs up", async () => {
    const call = connectFakeCall(businessId);

    // Greeting: assistant transcript + actual audio bytes flowed.
    await waitFor(() => call.events.transcripts.some((t) => t.role === "assistant"), 8000, "greeting transcript");
    await waitFor(() => call.events.audioBytes > 1000, 8000, "greeting audio");
    const greeting = call.events.transcripts.find((t) => t.role === "assistant")!;
    expect(greeting.content).toContain("Sunrise Dental Studio");

    // Ask about hours — mock LLM reads the resolved {{NOW}} context from the system prompt.
    call.sendText("What are your hours today?");
    await waitFor(
      () => call.events.transcripts.filter((t) => t.role === "assistant" && !t.partial).length >= 2,
      8000,
      "hours answer"
    );
    const hoursAnswer = call.events.transcripts.filter((t) => t.role === "assistant").at(-1)!;
    expect(hoursAnswer.content.toLowerCase()).toMatch(/open|closed/);

    // Book an appointment with details — mock LLM calls request_appointment.
    call.sendText("I'd like to book an appointment. My name is Jamie Rivera, my number is 555 010 0100, Friday afternoon works.");
    await waitFor(() => call.events.transcripts.some((t) => t.role === "tool"), 8000, "tool transcript");
    const toolLine = call.events.transcripts.find((t) => t.role === "tool")!;
    expect(toolLine.content).toContain("Appointment request");

    // The appointment actually landed in the DB.
    const appts = await fetchJson(`${baseUrl}/api/businesses/${businessId}/appointments`);
    expect(appts.length).toBeGreaterThan(0);
    expect(appts[0].name).toBe("Jamie Rivera");

    // Say goodbye — mock LLM calls end_call; session ends and closes the socket.
    call.sendText("That's everything, thank you. Goodbye!");
    await waitFor(() => call.events.statuses.some((s) => s.status === "ended"), 8000, "ended status");
    await call.events.closed;

    // Call record persisted with metrics + transcript.
    const callList = await fetchJson(`${baseUrl}/api/businesses/${businessId}/calls`);
    expect(callList.length).toBeGreaterThan(0);
    const detail = await fetchJson(`${baseUrl}/api/calls/${callList[0].id}`);
    expect(detail.call.status).toBe("completed");
    expect(detail.call.endedReason).toBe("assistant-ended");
    expect(detail.call.metrics.turns).toBe(3);
    expect(detail.turns.length).toBeGreaterThanOrEqual(6);
  }, 30000);

  it("handles interruption: new input mid-response aborts cleanly and the call continues", async () => {
    const call = connectFakeCall(businessId);
    await waitFor(() => call.events.transcripts.some((t) => t.role === "assistant"), 8000, "greeting");

    // Fire two inputs back-to-back; the second should cut off the first response.
    call.sendText("What are your hours today?");
    await new Promise((r) => setTimeout(r, 120));
    call.sendText("Actually, can you take a message? This is Sam Lee, 555 222 3333, please have Dr. Chen call me.");

    await waitFor(
      () => call.events.transcripts.some((t) => t.role === "tool" && t.content.includes("message")),
      10000,
      "message tool"
    );
    const msgs = await fetchJson(`${baseUrl}/api/businesses/${businessId}/messages`);
    expect(msgs.length).toBeGreaterThan(0);

    call.sendText("Goodbye!");
    await waitFor(() => call.events.statuses.some((s) => s.status === "ended"), 8000, "ended");
    await call.events.closed;
  }, 30000);

  it("audio-only path: mock STT turns sustained audio into a scripted utterance", async () => {
    const call = connectFakeCall(businessId);
    await waitFor(() => call.events.audioBytes > 1000, 8000, "greeting audio");

    // Send ~1.5s of "speech" (non-silence mulaw), then stop — MockStt should emit a final.
    const frame = Buffer.alloc(160, 0x40);
    for (let i = 0; i < 75; i++) {
      call.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: "MZfake",
          media: { payload: frame.toString("base64") },
        })
      );
      await new Promise((r) => setTimeout(r, 12));
    }
    await waitFor(
      () => call.events.transcripts.some((t) => t.role === "user" && !t.partial),
      10000,
      "spoken user turn"
    );
    call.ws.close();
    await call.events.closed;
  }, 30000);
});
