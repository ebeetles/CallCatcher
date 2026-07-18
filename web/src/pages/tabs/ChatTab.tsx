import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { streamChat } from "../../api";
import { fmtTokens } from "../../format";
import type { BusinessSummary, LlmUsage } from "../../types";
import { Empty, Lamp, Panel } from "../../ui";

interface Bubble {
  kind: "user" | "assistant";
  text: string;
  meta?: string;
}
interface Line {
  kind: "line";
  text: string;
  err?: boolean;
}
type Item = Bubble | Line;

export default function ChatTab({ biz, onActivity }: { biz: BusinessSummary; onActivity: () => void }) {
  const rcp = biz.receptionist;
  const [items, setItems] = useState<Item[]>(() => (rcp ? [{ kind: "assistant", text: rcp.greeting }] : []));
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [callOver, setCallOver] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [items]);

  if (!rcp) {
    return (
      <Empty title="No receptionist to talk to" body="Deploy a receptionist first — then you can test it here in text mode before a caller ever hears it.">
        <Link to={`/b/${biz.id}/receptionist`} className="btn btn-primary">
          Set up the receptionist
        </Link>
      </Empty>
    );
  }

  const newCall = () => {
    abortRef.current?.abort();
    setItems([{ kind: "assistant", text: rcp.greeting }]);
    setCallOver(false);
    setStreaming(false);
    onActivity();
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || callOver) return;
    setInput("");

    // Build the history the server needs (greeting + turns so far + this message).
    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const it of items) {
      if (it.kind === "user" || it.kind === "assistant") history.push({ role: it.kind, text: it.text });
    }
    history.push({ role: "user", text });

    setItems((prev) => [...prev, { kind: "user", text }, { kind: "assistant", text: "" }]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const updateLast = (fn: (b: Bubble) => Bubble) =>
      setItems((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const it = next[i];
          if (it.kind === "assistant") {
            next[i] = fn(it);
            break;
          }
        }
        return next;
      });

    try {
      await streamChat(
        biz.id,
        history,
        (ev) => {
          if (ev.type === "text") {
            updateLast((b) => ({ ...b, text: b.text + ev.delta }));
          } else if (ev.type === "tool") {
            setItems((prev) => [...prev, { kind: "line", text: ev.summary }, { kind: "assistant", text: "" }]);
          } else if (ev.type === "done") {
            const metaBits: string[] = [];
            if (ev.firstTokenMs !== undefined) metaBits.push(`${ev.firstTokenMs}ms to first word`);
            if (ev.usage) metaBits.push(`${fmtTokens((ev.usage as LlmUsage).inputTokens)} in · ${fmtTokens((ev.usage as LlmUsage).outputTokens)} out`);
            if (metaBits.length) updateLast((b) => ({ ...b, meta: metaBits.join(" · ") }));
            if (ev.error) setItems((prev) => [...prev, { kind: "line", text: ev.error!, err: true }]);
            if (ev.endAction === "end") {
              setItems((prev) => [...prev, { kind: "line", text: "receptionist ended the call" }]);
              setCallOver(true);
            } else if (ev.endAction === "transfer") {
              setItems((prev) => [
                ...prev,
                { kind: "line", text: `call would transfer to ${biz.forwardNumber || "the forward number"}` },
              ]);
              setCallOver(true);
            }
          }
        },
        ac.signal
      );
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setItems((prev) => [...prev, { kind: "line", text: e instanceof Error ? e.message : String(e), err: true }]);
      }
    } finally {
      // Drop any empty assistant bubble left behind (e.g. tool call with no follow-up text).
      setItems((prev) => prev.filter((it) => !(it.kind === "assistant" && it.text === "")));
      setStreaming(false);
      onActivity();
    }
  };

  return (
    <Panel
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          Test call · text mode
          <Lamp state={streaming ? "live" : callOver ? "off" : "ok"} pulse={streaming} />
        </span>
      }
      actions={
        <button className="btn btn-outline sm" onClick={newCall}>
          New call
        </button>
      }
      tight
    >
      <div className="chatbox">
        <div className="chatlog" ref={logRef}>
          {items.map((it, i) =>
            it.kind === "line" ? (
              <div key={i} className={`chatline${it.err ? " err" : ""}`}>
                — {it.text} —
              </div>
            ) : (
              <div key={i} className={`bubble ${it.kind}`}>
                {it.text || "…"}
                {it.meta ? <div className="b-meta">{it.meta}</div> : null}
              </div>
            )
          )}
          {callOver ? (
            <div className="chatline">
              call over ·{" "}
              <button className="btn btn-quiet sm" onClick={newCall} style={{ padding: "0 4px" }}>
                start another
              </button>
            </div>
          ) : null}
        </div>
        <div className="composer">
          <input
            className="input"
            placeholder={callOver ? "Call ended — start a new one" : "Say something as the caller…"}
            value={input}
            disabled={streaming || callOver}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            autoFocus
          />
          <button className="btn btn-primary" onClick={send} disabled={streaming || callOver || !input.trim()}>
            {streaming ? "…" : "Send"}
          </button>
        </div>
      </div>
    </Panel>
  );
}
