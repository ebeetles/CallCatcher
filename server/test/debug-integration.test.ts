import { beforeAll, test, expect } from "vitest";

process.env.MOCK_PROVIDERS = "1";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-debug-")), "test.sqlite");
process.env.PUBLIC_URL = "";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.DASHBOARD_TOKEN = "";

let baseUrl = "";

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  const app = await buildApp({ sessionTimers: { silencePromptMs: 60000, silenceHangupMs: 60000, playbackGraceMs: 1500 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as import("node:net").AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test("debug seed-demo response", async () => {
  const res = await fetch(`${baseUrl}/api/seed-demo`, { method: "POST" });
  const body = (await res.json()) as { id?: string };
  console.log("SEED-DEMO RESPONSE:", JSON.stringify(body, null, 2));
  console.log("STATUS:", res.status);
  expect(body.id).toBeTruthy();
});
