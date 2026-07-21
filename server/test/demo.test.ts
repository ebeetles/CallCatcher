/**
 * Public landing-page demo: the unauthenticated /api/public/demo-chat endpoint
 * and the demo block in /api/public/config. Uses mock providers, so the LLM
 * reply is scripted but the route/streaming/validation are exercised for real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-demo-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
// Public endpoint — force a clean auth env so it doesn't inherit the dev .env.
process.env.SUPABASE_URL = "";
process.env.SUPABASE_ANON_KEY = "";
process.env.SUPABASE_JWT_SECRET = "";
process.env.DASHBOARD_TOKEN = "";

let app: any;
let baseUrl = "";

async function readSse(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
}

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp({ sessionTimers: { silencePromptMs: 60000, silenceHangupMs: 60000, playbackGraceMs: 500 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("public config demo block", () => {
  it("advertises the demo receptionist's name and greeting", async () => {
    const cfg = (await fetch(`${baseUrl}/api/public/config`).then((r) => r.json())) as any;
    expect(cfg.demo).toBeTruthy();
    expect(cfg.demo.name).toBe("Sunrise Dental Studio");
    expect(typeof cfg.demo.greeting).toBe("string");
    expect(cfg.demo.greeting.length).toBeGreaterThan(0);
  });
});

describe("public demo chat", () => {
  it("streams a reply with no auth and ends with a done event", async () => {
    const res = await fetch(`${baseUrl}/api/public/demo-chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: [{ role: "user", text: "how much is a cleaning?" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("400s when history doesn't end with a user turn", async () => {
    const res = await fetch(`${baseUrl}/api/public/demo-chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: [{ role: "assistant", text: "Hi there" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("does not persist demo activity to any business (tools are simulated)", async () => {
    // The demo business id is not a real row — its inbox stays empty.
    const { messages, appointments } = await import("../src/db.ts");
    expect(messages.listForBusiness("biz_demo").length).toBe(0);
    expect(appointments.listForBusiness("biz_demo").length).toBe(0);
  });
});
