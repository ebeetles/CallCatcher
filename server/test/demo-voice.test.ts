/**
 * Public voice demo: the unauthenticated token endpoint + the real media-stream
 * pipeline driven by a browser-style fake caller (mock providers). Verifies a
 * token starts a session, the receptionist greets with audio, a turn round-trips,
 * and the demo tenant is hidden from the admin roster.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-demovoice-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_ANON_KEY = "";
process.env.SUPABASE_JWT_SECRET = "";
process.env.DASHBOARD_TOKEN = "";

let app: any;
let baseUrl = "";

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp({ sessionTimers: { silencePromptMs: 60000, silenceHangupMs: 60000, playbackGraceMs: 500 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

afterAll(async () => {
  await app?.close();
});

async function mintToken(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/public/demo-voice-token`, { method: "POST" });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).token;
}

interface FakeEvents {
  transcripts: Array<{ role: string; content: string }>;
  statuses: string[];
  audioBytes: number;
  closed: Promise<void>;
}

function connect(token: string): { ws: WebSocket; events: FakeEvents; say(t: string): void } {
  const ws = new WebSocket(baseUrl.replace("http", "ws") + "/media-stream");
  let resolveClosed: () => void;
  const events: FakeEvents = { transcripts: [], statuses: [], audioBytes: 0, closed: new Promise((r) => (resolveClosed = r)) };
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        event: "start",
        streamSid: "MZdemo",
        start: { streamSid: "MZdemo", customParameters: { token, web: "1", from: "+15550001234" } },
      })
    );
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.event === "media") events.audioBytes += Buffer.from(m.media.payload, "base64").length;
    else if (m.event === "transcript" && !m.partial) events.transcripts.push({ role: m.role, content: m.content });
    else if (m.event === "status") events.statuses.push(m.status);
    else if (m.event === "mark") ws.send(JSON.stringify({ event: "mark", streamSid: "MZdemo", mark: { name: m.mark.name } }));
  });
  ws.on("close", () => resolveClosed());
  return { ws, events, say: (t) => ws.send(JSON.stringify({ event: "text-input", text: t })) };
}

async function waitFor(cond: () => boolean, ms = 8000, label = "cond"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("public voice-demo token", () => {
  it("mints a single-use stream token without auth", async () => {
    const res = await fetch(`${baseUrl}/api/public/demo-voice-token`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });
});

describe("voice demo pipeline (fake browser caller)", () => {
  it("greets with audio, answers a turn, and hangs up", async () => {
    const token = await mintToken();
    const call = connect(token);

    await waitFor(() => call.events.transcripts.some((t) => t.role === "assistant"), 8000, "greeting");
    await waitFor(() => call.events.audioBytes > 500, 8000, "audio");
    expect(call.events.transcripts[0].content).toContain("Sunrise Dental Studio");
    expect(call.events.statuses).toContain("connected");

    call.say("how much is a cleaning?");
    await waitFor(() => call.events.transcripts.filter((t) => t.role === "assistant").length >= 2, 8000, "reply");

    call.ws.send(JSON.stringify({ event: "stop" }));
    await call.events.closed;
  }, 20000);

  it("rejects a media-stream with a bogus token", async () => {
    const call = connect("not-a-real-token");
    // The session rejects and closes without ever greeting.
    await call.events.closed;
    expect(call.events.transcripts.some((t) => t.role === "assistant")).toBe(false);
  }, 10000);
});

describe("demo tenant isolation", () => {
  it("is hidden from the platform admin tenants roster", async () => {
    // Open mode → the dev context is a platform admin, so /api/admin/tenants is reachable.
    await mintToken(); // ensure the demo tenant has been seeded
    const res = await fetch(`${baseUrl}/api/admin/tenants`);
    expect(res.status).toBe(200);
    const tenants = (await res.json()) as any[];
    expect(tenants.some((t: any) => t.id === "tnt_demo")).toBe(false);
  });
});
