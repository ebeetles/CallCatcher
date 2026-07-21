import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { streamDemoChat } from "../api";
import { Lamp, BrandMark } from "../ui";

/**
 * Public marketing page (logged-out "/" in supabase mode) — the catalog page
 * of the telecom-manual design system. Signature element: a live switchboard
 * line card the visitor can actually talk to — a real AI receptionist for a
 * demo dental clinic, answering, quoting prices, and printing appointment
 * tickets, over the public /api/public/demo-chat endpoint.
 */

const SUGGESTIONS = [
  "How much is a cleaning?",
  "Are you open Saturday?",
  "Book me a cleaning Friday afternoon",
];

type DemoItem =
  | { kind: "ai" | "caller"; text: string }
  | { kind: "ticket"; text: string }
  | { kind: "note"; text: string };

/** The interactive demo: type as the caller, the real receptionist answers. */
function DemoConsole() {
  const { config } = useAuth();
  const greeting = config?.demo?.greeting ?? "Thanks for calling! How can I help you today?";
  const bizName = config?.demo?.name ?? "Sunrise Dental Studio";

  const [items, setItems] = useState<DemoItem[]>([{ kind: "ai", text: greeting }]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keep the greeting in sync once config arrives (only before the first turn).
  useEffect(() => {
    if (!started) setItems([{ kind: "ai", text: greeting }]);
  }, [greeting, started]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || streaming) return;
    setInput("");
    setStarted(true);

    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const it of items) {
      if (it.kind === "ai") history.push({ role: "assistant", text: it.text });
      else if (it.kind === "caller") history.push({ role: "user", text: it.text });
    }
    history.push({ role: "user", text });

    setItems((prev) => [...prev, { kind: "caller", text }, { kind: "ai", text: "" }]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const appendToAi = (delta: string) =>
      setItems((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].kind === "ai") {
            next[i] = { kind: "ai", text: (next[i] as { text: string }).text + delta };
            break;
          }
        }
        return next;
      });

    try {
      await streamDemoChat(
        history,
        (ev) => {
          if (ev.type === "text") appendToAi(ev.delta);
          else if (ev.type === "tool") setItems((prev) => [...prev, { kind: "ticket", text: ev.summary }, { kind: "ai", text: "" }]);
          else if (ev.type === "done" && ev.error) setItems((prev) => [...prev, { kind: "note", text: ev.error! }]);
        },
        ac.signal
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setItems((prev) => [...prev, { kind: "note", text: e instanceof Error ? e.message : String(e) }]);
      }
    } finally {
      setItems((prev) => prev.filter((it) => !(it.kind === "ai" && it.text === "")));
      setStreaming(false);
    }
  };

  return (
    <div className="callticket" aria-label={`Live demo call with the ${bizName} AI receptionist`}>
      <div className="callticket-head">
        <Lamp state={streaming ? "live" : "ok"} pulse={streaming} />
        <span className="mono">LINE 04 · {bizName.toUpperCase()}</span>
        <span className="callticket-status mono">{streaming ? "LIVE" : "TRY IT →"}</span>
      </div>
      <div className="callticket-body" ref={bodyRef}>
        {items.map((it, i) =>
          it.kind === "ticket" ? (
            <div key={i} className="ct-ticket">
              <span className="mono">CAPTURED — PRINTED TO INBOX</span>
              {it.text}
            </div>
          ) : it.kind === "note" ? (
            <p key={i} className="ct-note mono">{it.text}</p>
          ) : (
            <p key={i} className={`ct-turn ${it.kind}`}>
              <span className="ct-who mono">{it.kind === "ai" ? "AI" : "YOU"}</span>
              {it.text || (streaming ? "…" : "")}
            </p>
          )
        )}
      </div>
      {!started ? (
        <div className="ct-suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="ct-chip" onClick={() => send(s)} disabled={streaming}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="ct-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          className="input"
          placeholder="You're the caller — ask anything…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={streaming}
          aria-label="Message to the demo receptionist"
        />
        <button className="btn btn-primary" type="submit" disabled={streaming || !input.trim()}>
          {streaming ? "…" : "Send"}
        </button>
      </form>
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
        <DemoConsole />
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
