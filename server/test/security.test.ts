/**
 * Security layer: Twilio signature validation, dashboard token auth,
 * media-stream token gating, SSRF guards, log redaction. Runs the real
 * server with DASHBOARD_TOKEN + TWILIO_AUTH_TOKEN set (unlike
 * integration.test.ts, which runs it wide open the way local dev does).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DASH_TOKEN = "test-dashboard-token";
const TW_TOKEN = "twilio-auth-token-test";
const PUBLIC_URL = "https://catcher.example.com";

process.env.MOCK_PROVIDERS = "1";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "callcatcher-sec-")), "test.sqlite");
process.env.PUBLIC_URL = PUBLIC_URL;
process.env.DASHBOARD_TOKEN = DASH_TOKEN;
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = TW_TOKEN;
// Pin to legacy token mode regardless of the developer's .env (Supabase vars
// would otherwise flip authMode to "supabase" and change the gating tested here).
process.env.SUPABASE_URL = "";
process.env.SUPABASE_ANON_KEY = "";
process.env.SUPABASE_JWT_SECRET = "";

let app: any;
let baseUrl = "";
let businessId = "";
const auth = { authorization: `Bearer ${DASH_TOKEN}` };

/** Sign a webhook the way Twilio does: HMAC-SHA1 over url + sorted key/value concat. */
function twilioSign(url: string, params: Record<string, string>, authToken: string): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

beforeAll(async () => {
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp({ sessionTimers: { silencePromptMs: 60000, silenceHangupMs: 60000, playbackGraceMs: 500 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const seeded = (await fetch(`${baseUrl}/api/seed-demo`, { method: "POST", headers: auth }).then((r) => r.json())) as { id: string };
  businessId = seeded.id;
  expect(businessId).toBeTruthy();
});

afterAll(async () => {
  await app?.close();
});

describe("twilio signature validation", () => {
  it("matches the canonical example from Twilio's docs", async () => {
    const { validateTwilioSignature } = await import("../src/security.ts");
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    };
    const ok = validateTwilioSignature({
      authToken: "12345",
      url: "https://mycompany.com/myapp.php?foo=1&bar=2",
      params,
      signature: "0/KCTR6DLpKmkAf8muzZqo1nDgQ=", // published expected value
    });
    expect(ok).toBe(true);
    expect(
      validateTwilioSignature({
        authToken: "12345",
        url: "https://mycompany.com/myapp.php?foo=1&bar=2",
        params: { ...params, Digits: "9999" },
        signature: "0/KCTR6DLpKmkAf8muzZqo1nDgQ=",
      })
    ).toBe(false);
  });

  it("rejects unsigned and badly-signed webhook posts", async () => {
    const form = "To=%2B15550001111&From=%2B15550002222&CallSid=CAxyz";
    const post = (sig?: string) =>
      fetch(`${baseUrl}/twilio/voice`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(sig ? { "x-twilio-signature": sig } : {}),
        },
        body: form,
      });
    expect((await post()).status).toBe(403);
    expect((await post("bogus")).status).toBe(403);
  });

  it("accepts a correctly signed webhook post", async () => {
    const params = { To: "+15550009999", From: "+15550002222", CallSid: "CAxyz" };
    const sig = twilioSign(`${PUBLIC_URL}/twilio/voice`, params, TW_TOKEN);
    const res = await fetch(`${baseUrl}/twilio/voice`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response>"); // unrecognized number → polite hangup TwiML
  });
});

describe("dashboard api auth", () => {
  it("401s /api without (or with a wrong) bearer token", async () => {
    expect((await fetch(`${baseUrl}/api/businesses`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/businesses`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("serves /api with the right token", async () => {
    const res = await fetch(`${baseUrl}/api/businesses`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBeGreaterThan(0);
  });

  it("does not 401 CORS preflights", async () => {
    const res = await fetch(`${baseUrl}/api/businesses`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(res.status).not.toBe(401);
  });

  it("does not reflect arbitrary origins in CORS", async () => {
    const res = await fetch(`${baseUrl}/api/businesses`, {
      headers: { ...auth, origin: "https://evil.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await fetch(`${baseUrl}/api/businesses`, { headers: { ...auth, origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});

describe("media-stream gating", () => {
  function openStream(customParameters: Record<string, string>): Promise<{ closed: boolean; gotTranscript: boolean }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(baseUrl.replace("http", "ws") + "/media-stream");
      let gotTranscript = false;
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZsec", callSid: "CAsec", customParameters },
            streamSid: "MZsec",
          })
        );
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "transcript") gotTranscript = true;
      });
      ws.on("close", () => resolve({ closed: true, gotTranscript }));
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
          resolve({ closed: false, gotTranscript });
        }
      }, 2500);
    });
  }

  it("rejects phone streams without a one-time token", async () => {
    const r = await openStream({ businessId });
    expect(r.closed).toBe(true);
    expect(r.gotTranscript).toBe(false);
  });

  it("rejects web streams with a bogus token", async () => {
    const r = await openStream({ businessId, web: "1", token: "wrong" });
    expect(r.closed).toBe(true);
    expect(r.gotTranscript).toBe(false);
  });

  it("rejects web streams presenting the raw dashboard token (must mint a stream token)", async () => {
    const r = await openStream({ businessId, web: "1", token: DASH_TOKEN, from: "+15550001234" });
    expect(r.gotTranscript).toBe(false);
  });

  it("accepts web streams with a minted stream token, and binds them to the business", async () => {
    const minted = (await fetch(`${baseUrl}/api/businesses/${businessId}/stream-token`, {
      method: "POST",
      headers: auth,
    }).then((r) => r.json())) as { token: string };
    expect(minted.token).toBeTruthy();
    // Client-sent businessId is ignored in favor of the token's grant.
    const r = await openStream({ businessId: "biz_spoofed", web: "1", token: minted.token, from: "+15550001234" });
    expect(r.gotTranscript).toBe(true); // greeting arrived — session actually started
  });

  it("refuses to mint stream tokens without auth", async () => {
    const res = await fetch(`${baseUrl}/api/businesses/${businessId}/stream-token`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("stream tokens are single-use and carry the business grant", async () => {
    const { mintStreamToken, consumeStreamToken } = await import("../src/security.ts");
    const t = mintStreamToken({ businessId: "biz_x", web: false });
    expect(consumeStreamToken(t)).toEqual({ businessId: "biz_x", web: false });
    expect(consumeStreamToken(t)).toBeUndefined(); // single use
    expect(consumeStreamToken("unknown")).toBeUndefined();
    expect(consumeStreamToken(undefined)).toBeUndefined();
  });
});

describe("ssrf guard", () => {
  it("classifies private and public addresses", async () => {
    const { ipIsPrivate } = await import("../src/security.ts");
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "fd00::1", "fe80::1",
      // v4-embedded spellings — new URL() normalizes ::ffff:127.0.0.1 to the hex form
      "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1",
    ]) {
      expect(ipIsPrivate(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.72.14", "2607:f8b0::1", "::ffff:808:808"]) {
      expect(ipIsPrivate(ip), ip).toBe(false);
    }
  });

  it("refuses internal hostnames and private literals", async () => {
    const { assertPublicHost } = await import("../src/security.ts");
    await expect(assertPublicHost(new URL("http://localhost:8787/x"))).rejects.toThrow();
    await expect(assertPublicHost(new URL("http://127.0.0.1/x"))).rejects.toThrow();
    await expect(assertPublicHost(new URL("http://169.254.169.254/latest/meta-data/"))).rejects.toThrow();
    await expect(assertPublicHost(new URL("http://[::ffff:127.0.0.1]/x"))).rejects.toThrow(); // URL stores this as [::ffff:7f00:1]
    await expect(assertPublicHost(new URL("ftp://example.com/x"))).rejects.toThrow();
  });
});

describe("log redaction", () => {
  it("masks all but the last 4 digits", async () => {
    const { maskPhone } = await import("../src/security.ts");
    expect(maskPhone("+15550001234")).toBe("+•••••••1234");
    expect(maskPhone(undefined)).toBe("(none)");
  });
});
