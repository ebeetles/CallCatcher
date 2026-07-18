import { useEffect, useState } from "react";
import { getEstimate } from "../api";
import { useStatus } from "../App";
import { money } from "../format";
import type { MonthlyEstimate } from "../types";
import { ErrorNote, Field, PageHead, Panel, Spinner } from "../ui";

export default function RateCard() {
  const status = useStatus();
  const [callsPerDay, setCallsPerDay] = useState(12);
  const [avgCallMinutes, setAvgCallMinutes] = useState(2.5);
  const [llmModel, setLlmModel] = useState("claude-haiku-4-5");
  const [ttsProvider, setTtsProvider] = useState("deepgram");
  const [est, setEst] = useState<MonthlyEstimate | undefined>();
  const [err, setErr] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      getEstimate({ callsPerDay, avgCallMinutes, llmModel, ttsProvider })
        .then((e) => alive && (setEst(e), setErr(undefined)))
        .catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    }, 150);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [callsPerDay, avgCallMinutes, llmModel, ttsProvider]);

  const pricing = status?.pricing;
  const llmModels = pricing ? Object.keys(pricing.llm).filter((m) => m !== "mock") : [llmModel];
  const ttsProviders = pricing ? Object.keys(pricing.tts).map((k) => k.replace(/Per1kChars$/, "")).filter((p) => p !== "mock") : [ttsProvider];

  return (
    <div className="page">
      <PageHead
        sec="SEC 03"
        eyebrow="Rate card"
        title="What a receptionist costs to run"
        sub="Provider costs only — what you charge the business on top is your margin. Estimates use typical receptionist-call behavior."
      />

      <div className="twopane">
        <div>
          <Panel title="Estimate a line">
            <div className="formrow c2">
              <Field label="Calls per day">
                <input className="input" type="number" min={1} max={500} value={callsPerDay} onChange={(e) => setCallsPerDay(Number(e.target.value) || 1)} />
              </Field>
              <Field label="Average call (minutes)">
                <input
                  className="input"
                  type="number"
                  min={0.5}
                  max={30}
                  step={0.5}
                  value={avgCallMinutes}
                  onChange={(e) => setAvgCallMinutes(Number(e.target.value) || 0.5)}
                />
              </Field>
              <Field label="Call model">
                <select className="select" value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                  {llmModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Voice provider">
                <select className="select" value={ttsProvider} onChange={(e) => setTtsProvider(e.target.value)}>
                  {ttsProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {err ? <ErrorNote msg={err} /> : null}
            {est ? (
              <div style={{ marginTop: 6 }}>
                <div className="bignum">{money(est.monthlyTotal, 2)}</div>
                <div className="bignum-sub">
                  per month · {est.minutesPerMonth.toLocaleString()} minutes · {money(est.perMinute)} per minute + {money(est.monthlyNumber, 2)} number rental
                </div>
                <table className="table ratetable" style={{ marginTop: 16, maxWidth: 420 }}>
                  <tbody>
                    <tr>
                      <td>Telephony (Twilio inbound)</td>
                      <td>{money(est.breakdown.telephonyPerMin)}/min</td>
                    </tr>
                    <tr>
                      <td>Hearing the caller (STT)</td>
                      <td>{money(est.breakdown.sttPerMin)}/min</td>
                    </tr>
                    <tr>
                      <td>Speaking (TTS)</td>
                      <td>{money(est.breakdown.ttsPerMin)}/min</td>
                    </tr>
                    <tr>
                      <td>Thinking ({llmModel})</td>
                      <td>{money(est.breakdown.llmPerMin)}/min</td>
                    </tr>
                    <tr>
                      <td>
                        <strong>Usage subtotal</strong>
                      </td>
                      <td>
                        <strong>{money(est.monthlyUsage, 2)}/mo</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : !err ? (
              <Spinner label="Calculating…" />
            ) : null}
          </Panel>
        </div>

        <div>
          {pricing ? (
            <Panel title="Published rates" tight>
              <table className="table ratetable">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style={{ textAlign: "right" }}>Rate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Twilio inbound voice</td>
                    <td>{money(pricing.telephony.twilioInboundPerMin)}/min</td>
                  </tr>
                  <tr>
                    <td>Twilio number rental</td>
                    <td>{money(pricing.telephony.twilioNumberMonthly, 2)}/mo</td>
                  </tr>
                  <tr>
                    <td>Deepgram streaming STT</td>
                    <td>{money(pricing.stt.deepgramPerMin)}/min</td>
                  </tr>
                  <tr>
                    <td>Deepgram Aura TTS</td>
                    <td>{money(pricing.tts.deepgramPer1kChars)}/1k chars</td>
                  </tr>
                  <tr>
                    <td>ElevenLabs Flash TTS</td>
                    <td>{money(pricing.tts.elevenlabsPer1kChars)}/1k chars</td>
                  </tr>
                  {Object.entries(pricing.llm)
                    .filter(([m]) => m !== "mock")
                    .map(([m, r]) => (
                      <tr key={m}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {m}
                        </td>
                        <td>
                          {money(r.inPerM, 2)} in · {money(r.outPerM, 2)} out /M tok
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Panel>
          ) : null}
          <p style={{ color: "var(--faint)", fontSize: 12 }}>
            Rates checked July 2026 — update <span style={{ fontFamily: "var(--mono)" }}>server/src/costs.ts</span> when providers change pricing.
          </p>
        </div>
      </div>
    </div>
  );
}
