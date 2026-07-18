/**
 * Scripted fake caller for local dev: speaks the Twilio Media Streams
 * protocol (plus the web text-input extension) against a RUNNING server,
 * so you can exercise the real pipeline and populate the dashboard without
 * dialing a phone. Usage:
 *
 *   npm run fake-call                  # first business, default script
 *   npm run fake-call -- <businessId>
 *   PORT=8787 npm run fake-call
 */
import WebSocket from "ws";

const port = Number(process.env.PORT || 8787);
const base = `http://127.0.0.1:${port}`;
// Matches the server's DASHBOARD_TOKEN when one is set (not needed for tokenless dev).
const token = process.env.DASHBOARD_TOKEN ?? "";
const authHeaders: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

const SCRIPT: Array<{ say: string; waitMs?: number }> = [
  { say: "Hi — what are your hours today?" },
  { say: "How much is a teeth cleaning?" },
  {
    say: "Great, I'd like to book an appointment. My name is Jamie Rivera, my number is 555 010 0100, Friday afternoon works best.",
    waitMs: 1200,
  },
  { say: "That's everything, thank you. Goodbye!" },
];

async function main() {
  const arg = process.argv[2];
  let businessId = arg;
  if (!businessId) {
    const businesses = (await fetch(`${base}/api/businesses`, { headers: authHeaders }).then((r) => r.json())) as Array<{ id: string; name: string; receptionist?: unknown }>;
    const target = businesses.find((b) => b.receptionist) ?? businesses[0];
    if (!target) {
      console.error("No businesses on the server — create one in the dashboard first (or POST /api/seed-demo).");
      process.exit(1);
    }
    businessId = target.id;
    console.log(`Calling ${target.name} (${businessId})…\n`);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
  let scriptIdx = 0;
  let assistantDone = 0;
  let ended = false;

  const sendNext = () => {
    if (ended || scriptIdx >= SCRIPT.length) return;
    const line = SCRIPT[scriptIdx++];
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      console.log(`  CALLER  ${line.say}`);
      ws.send(JSON.stringify({ event: "text-input", text: line.say }));
    }, line.waitMs ?? 600);
  };

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        start: {
          streamSid: "MZfakecli",
          callSid: `CAfake${Date.now()}`,
          customParameters: { businessId, web: "1", from: "+15550001234", ...(token ? { token } : {}) },
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
        streamSid: "MZfakecli",
      })
    );
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "mark") {
      // Twilio echoes marks once buffered audio has played out.
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "mark", streamSid: "MZfakecli", mark: { name: msg.mark.name } }));
        }
      }, 30);
    } else if (msg.event === "transcript" && !msg.partial) {
      if (msg.role === "assistant") {
        console.log(`  AI      ${msg.content}`);
        assistantDone += 1;
        sendNext();
      } else if (msg.role === "tool") {
        console.log(`  · ${msg.content}`);
      }
    } else if (msg.event === "status") {
      console.log(`\n[call ${msg.status}${msg.reason ? ` — ${msg.reason}` : ""}]`);
      if (msg.status === "ended") ended = true;
    }
  });

  ws.on("close", () => {
    console.log("[socket closed]");
    process.exit(0);
  });
  ws.on("error", (err) => {
    console.error(`WebSocket error: ${err.message} — is the server running on ${base}?`);
    process.exit(1);
  });

  // Safety: bail if the call never ends.
  setTimeout(() => {
    console.error("Timed out after 60s — closing.");
    ws.close();
    process.exit(1);
  }, 60000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
