import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { Lamp, BrandMark } from "../ui";

/**
 * Public marketing page (logged-out "/" in supabase mode) — the catalog page
 * of the telecom-manual design system. Signature element: a switchboard line
 * card that answers a call in real time, typing out the transcript and
 * printing the appointment ticket the receptionist captured.
 */

const DEMO_TURNS: Array<{ role: "caller" | "ai"; text: string }> = [
  { role: "ai", text: "Thanks for calling Sunrise Dental, this is the front desk. How can I help?" },
  { role: "caller", text: "Hi — do you have anything Friday afternoon? My crown came loose." },
  { role: "ai", text: "Ouch — we can get you in. Friday we're open till 2. Can I grab your name and number?" },
  { role: "caller", text: "Jamie Rivera, 555-010-0100." },
  { role: "ai", text: "Got it, Jamie. I've put in an urgent request for Friday — the team will text you the exact time shortly." },
];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

const RING_MS = 1400;
const CHAR_MS = 22;
const TURN_GAP_MS = 520;

/**
 * The live call ticket: rings, answers, types the transcript, prints the
 * ticket. The frame is derived purely from elapsed time, so remounts
 * (StrictMode, HMR) can't fork the animation.
 */
function CallTicket() {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<"ringing" | "live" | "done">(reduced ? "done" : "ringing");
  const [turns, setTurns] = useState<Array<{ role: string; text: string }>>(reduced ? DEMO_TURNS : []);
  const startRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (reduced) {
      setPhase("done");
      setTurns(DEMO_TURNS);
      return;
    }
    startRef.current ??= performance.now();
    let lastFrame = "";
    const iv = window.setInterval(() => {
      const elapsed = performance.now() - (startRef.current ?? 0) - RING_MS;
      if (elapsed < 0) return; // still ringing
      let rem = elapsed;
      const out: Array<{ role: string; text: string }> = [];
      for (const t of DEMO_TURNS) {
        const typeMs = t.text.length * CHAR_MS;
        if (rem >= typeMs + TURN_GAP_MS) {
          out.push(t);
          rem -= typeMs + TURN_GAP_MS;
          continue;
        }
        const chars = Math.floor(rem / CHAR_MS);
        if (chars > 0) out.push({ role: t.role, text: t.text.slice(0, chars) });
        const frame = out.map((o) => o.text.length).join(",");
        if (frame !== lastFrame) {
          lastFrame = frame;
          setPhase("live");
          setTurns(out);
        }
        return;
      }
      setTurns(DEMO_TURNS);
      setPhase("done");
      window.clearInterval(iv);
    }, 66);
    return () => window.clearInterval(iv);
  }, [reduced]);

  const secs = Math.min(41, Math.round(Math.max(0, performance.now() - (startRef.current ?? 0) - RING_MS) / 300));
  return (
    <div className="callticket" aria-label="Example call answered by a CallCatcher receptionist">
      <div className="callticket-head">
        <Lamp state={phase === "ringing" ? "bell" : phase === "live" ? "live" : "ok"} pulse={phase !== "done"} />
        <span className="mono">LINE 04 · SUNRISE DENTAL</span>
        <span className="callticket-status mono">
          {phase === "ringing" ? "RINGING…" : phase === "live" ? `ANSWERED · 00:${String(secs).padStart(2, "0")}` : "LOGGED · 00:41"}
        </span>
      </div>
      <div className="callticket-body">
        {turns.map((t, i) => (
          <p key={i} className={`ct-turn ${t.role}`}>
            <span className="ct-who mono">{t.role === "ai" ? "AI" : "CALLER"}</span>
            {t.text}
          </p>
        ))}
        {phase === "done" ? (
          <div className="ct-ticket">
            <span className="mono">📅 APPOINTMENT REQUEST — PRINTED TO INBOX</span>
            Jamie Rivera · crown repair · Friday PM · 555-010-0100 · urgent
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function Landing() {
  const { config } = useAuth();
  const plans = config?.plans ?? [];

  return (
    <div className="landing">
      <header className="landing-top">
        <span className="brand">
          <BrandMark />
          CallCatcher
        </span>
        <nav>
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <Link to="/login">Sign in</Link>
          <Link to="/signup" className="btn btn-primary">
            Start free trial
          </Link>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="lh-copy">
          <p className="eyebrow">
            <b>BULLETIN 01</b> · FOR AGENCIES &amp; RESELLERS
          </p>
          <h1>
            Put an AI receptionist on every client&rsquo;s phone&nbsp;line.
          </h1>
          <p className="lh-sub">
            CallCatcher compiles a small business&rsquo;s hours, services, and policies into a voice
            agent on a real phone number: it answers, quotes prices, takes messages, books
            appointment requests, and logs every word. You run the roster from one console and
            set your own price.
          </p>
          <div className="lh-cta">
            <Link to="/signup" className="btn btn-primary btn-lg">
              Start free trial
            </Link>
            <span className="lh-cta-note">14 days · no card · working receptionist in minutes</span>
          </div>
          <div className="lh-specs mono">
            <span>ANSWERS 24/7</span>
            <span>BARGE-IN AWARE</span>
            <span>FULL TRANSCRIPTS</span>
            <span>~$1/DAY PROVIDER COST</span>
          </div>
        </div>
        <CallTicket />
      </section>

      <section className="landing-sec" id="how">
        <p className="eyebrow">
          <b>SEC 02</b> · HOW A LINE GOES LIVE
        </p>
        <div className="lh-steps">
          <div className="lh-step">
            <span className="lh-step-n mono">01</span>
            <h3>Profile the business</h3>
            <p>
              Type in hours, services, FAQs, and policies — or paste their website and let the
              factory extract it. Five minutes of forms, once per client.
            </p>
          </div>
          <div className="lh-step">
            <span className="lh-step-n mono">02</span>
            <h3>Compile the receptionist</h3>
            <p>
              CallCatcher writes a voice-tuned prompt, wires up tools for messages, bookings, and
              transfers, and lets you rehearse by text chat before anyone dials.
            </p>
          </div>
          <div className="lh-step">
            <span className="lh-step-n mono">03</span>
            <h3>Put it on a number</h3>
            <p>
              Buy a local number in one click (or port the one they have). From the first ring,
              every call lands in your console with a transcript, cost, and captured work.
            </p>
          </div>
        </div>
      </section>

      <section className="landing-sec landing-sec-dim">
        <p className="eyebrow">
          <b>SEC 03</b> · WHAT&rsquo;S ON THE BOARD
        </p>
        <div className="lh-equip">
          {[
            ["Live transcripts", "every call logged turn by turn, with interruptions marked"],
            ["Message + booking inbox", "callers' requests land as tickets you confirm or decline"],
            ["Owner SMS alerts", "urgent messages text the business owner from their own line"],
            ["Call transfers", "hands hot calls to a human when it should"],
            ["Cost metering", "per-call provider cost, so you always know your margin"],
            ["Versioned prompts", "every receptionist deploy is kept and revertible"],
            ["Natural voices", "Deepgram Aura standard, ElevenLabs on Pro and up"],
            ["Isolated telephony", "each agency gets its own Twilio subaccount"],
          ].map(([t, d]) => (
            <div className="lh-equip-row" key={t}>
              <Lamp state="ok" />
              <b>{t}</b>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-sec" id="pricing">
        <p className="eyebrow">
          <b>SEC 04</b> · RATE CARD
        </p>
        <h2 className="lh-h2">Priced for margin.</h2>
        <p className="lh-sub" style={{ maxWidth: 560 }}>
          Agencies typically charge small businesses $150&ndash;$400 a month for a receptionist
          line. Your plan covers the AI and our platform; the spread is yours.
        </p>
        <div className="lh-pricing">
          {plans.map((p) => (
            <div className={`lh-plan${p.id === "pro" ? " featured" : ""}`} key={p.id}>
              {p.id === "pro" ? <span className="lh-plan-flag mono">MOST AGENCIES</span> : null}
              <h3>{p.label}</h3>
              <div className="lh-price">
                <span className="mono">${p.priceUsd}</span>/mo
              </div>
              <ul>
                <li>
                  {p.maxBusinesses} client business{p.maxBusinesses === 1 ? "" : "es"}
                </li>
                <li>{p.includedMinutes.toLocaleString()} call minutes / month</li>
                <li>{p.elevenlabs ? "Premium ElevenLabs voices" : "Standard voices"}</li>
                <li>Numbers, transcripts, inbox, SMS alerts</li>
              </ul>
              <Link to="/signup" className={`btn ${p.id === "pro" ? "btn-primary" : "btn-quiet"}`}>
                Start with {p.label}
              </Link>
            </div>
          ))}
        </div>
        <p className="lh-fineprint">
          Every account starts with a 14-day free trial — one business, 60 minutes, every feature.
          Phone numbers bill at Twilio&rsquo;s rate (~$1.15/mo each).
        </p>
      </section>

      <section className="landing-final">
        <h2>The next call your client misses could have been booked.</h2>
        <Link to="/signup" className="btn btn-primary btn-lg">
          Start free trial
        </Link>
      </section>

      <footer className="landing-foot mono">
        <span>● CALLCATCHER BSP C46.121</span>
        <span>
          <Link to="/login">SIGN IN</Link> · <a href="#pricing">RATES</a>
        </span>
      </footer>
    </div>
  );
}
