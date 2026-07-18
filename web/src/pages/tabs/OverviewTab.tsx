import { useState } from "react";
import { Link } from "react-router-dom";
import { attachNumber, detachNumber, listOwnedNumbers, provisionNumber, searchNumbers } from "../../api";
import { fmtPhone, money } from "../../format";
import type { AvailableNumber, BusinessSummary, OwnedNumber, StatusResponse } from "../../types";
import { TOOL_LABELS } from "../../types";
import { Chip, ErrorNote, Panel, Stat } from "../../ui";

function NumberPanel({ biz, status, reload }: { biz: BusinessSummary; status?: StatusResponse; reload: () => void }) {
  const [areaCode, setAreaCode] = useState("");
  const [results, setResults] = useState<AvailableNumber[] | undefined>();
  const [owned, setOwned] = useState<OwnedNumber[] | undefined>();
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [err, setErr] = useState<string | undefined>();

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const numberFee = status ? money(status.pricing.telephony.twilioNumberMonthly) : "$1.15";

  return (
    <Panel title="Phone line" lamp={biz.number ? "ok" : "amber"}>
      {biz.number ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 20, color: "var(--bell-deep)" }}>{fmtPhone(biz.number.e164)}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
            <Chip tone={biz.number.status === "active" ? "ok" : "amber"}>{biz.number.status === "active" ? "Webhook configured" : `Status: ${biz.number.status}`}</Chip>
            {status?.publicUrl ? (
              <Chip mono title="Twilio voice webhook">{status.publicUrl}/twilio/voice</Chip>
            ) : null}
            <button
              className="btn btn-quiet sm"
              disabled={busy !== undefined}
              onClick={() => run("detach", async () => { await detachNumber(biz.id); reload(); })}
              style={{ marginLeft: "auto", color: "var(--muted)" }}
            >
              {busy === "detach" ? "Detaching…" : "Detach"}
            </button>
          </div>
        </div>
      ) : (
        <p style={{ margin: "0 0 12px", color: "var(--muted)" }}>
          No number on this line yet. Until one is attached, the receptionist can only take test calls.
        </p>
      )}

      {!status?.publicUrl ? (
        <div className="note warn">
          No public URL set — Twilio can't reach this server. Set <span className="mono">PUBLIC_URL</span> in{" "}
          <span className="mono">.env</span> (e.g. an ngrok https URL) and restart the server.
        </div>
      ) : null}

      {err ? <ErrorNote msg={err} /> : null}

      {status?.twilioReady ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="input sm"
              style={{ width: 130 }}
              placeholder="Area code (626)"
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value)}
            />
            <button
              className="btn btn-outline sm"
              disabled={busy !== undefined}
              onClick={() => run("search", async () => setResults((await searchNumbers(biz.id, { areaCode: areaCode || undefined })).numbers))}
            >
              {busy === "search" ? "Searching…" : "Search new numbers"}
            </button>
            <button
              className="btn btn-quiet sm"
              disabled={busy !== undefined}
              onClick={() => run("owned", async () => setOwned((await listOwnedNumbers()).numbers))}
            >
              {busy === "owned" ? "Loading…" : "Show numbers you already own"}
            </button>
          </div>

          {results ? (
            results.length ? (
              <table className="table" style={{ marginTop: 12 }}>
                <tbody>
                  {results.map((n) => (
                    <tr key={n.e164}>
                      <td className="mono">{fmtPhone(n.e164)}</td>
                      <td style={{ color: "var(--muted)" }}>{[n.locality, n.region].filter(Boolean).join(", ")}</td>
                      <td className="num">
                        <button
                          className="btn btn-primary sm"
                          disabled={busy !== undefined}
                          onClick={() => {
                            if (!window.confirm(`Buy ${fmtPhone(n.e164)} on your Twilio account (${numberFee}/month) and point it at this receptionist?`)) return;
                            run("buy", async () => {
                              await provisionNumber(biz.id, n.e164);
                              setResults(undefined);
                              reload();
                            });
                          }}
                        >
                          Buy · {numberFee}/mo
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: "var(--muted)", marginTop: 12 }}>No numbers found for that search.</p>
            )
          ) : null}

          {owned ? (
            owned.length ? (
              <table className="table" style={{ marginTop: 12 }}>
                <tbody>
                  {owned.map((n) => (
                    <tr key={n.sid}>
                      <td className="mono">{fmtPhone(n.e164)}</td>
                      <td style={{ color: "var(--muted)", fontSize: 12 }}>{n.voiceUrl || "no webhook"}</td>
                      <td className="num">
                        <button
                          className="btn btn-outline sm"
                          disabled={busy !== undefined}
                          onClick={() =>
                            run("attach", async () => {
                              await attachNumber(biz.id, n.e164, n.sid);
                              setOwned(undefined);
                              reload();
                            })
                          }
                        >
                          Attach here
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: "var(--muted)", marginTop: 12 }}>No numbers on the Twilio account yet.</p>
            )
          ) : null}
        </>
      ) : (
        <>
          <div className="note">
            Add <span className="mono">TWILIO_ACCOUNT_SID</span> and <span className="mono">TWILIO_AUTH_TOKEN</span> to{" "}
            <span className="mono">.env</span> to search and buy numbers from here. You can still record a number manually:
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="input sm mono"
              style={{ width: 180 }}
              placeholder="+16265550123"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button
              className="btn btn-outline sm"
              disabled={!manual.trim() || busy !== undefined}
              onClick={() =>
                run("manual", async () => {
                  await attachNumber(biz.id, manual.trim());
                  setManual("");
                  reload();
                })
              }
            >
              Record number
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

export default function OverviewTab({ biz, status, reload }: { biz: BusinessSummary; status?: StatusResponse; reload: () => void }) {
  const r = biz.receptionist;
  return (
    <div>
      <div className="statrow">
        <Stat value={biz.stats.today} label="Calls today" />
        <Stat value={biz.stats.total} label="Calls all-time" />
        <Stat value={biz.stats.totalMinutes} label="Minutes on the line" />
        <Stat value={r ? `v${r.version}` : "—"} label="Receptionist" sub={r ? r.personality : "not deployed"} />
      </div>

      <div className="twopane">
        <div>
          <NumberPanel biz={biz} status={status} reload={reload} />
        </div>
        <div>
          <Panel
            title="Receptionist"
            lamp={r ? "ok" : "off"}
            actions={
              <Link to={`/b/${biz.id}/receptionist`} className="btn btn-outline sm">
                {r ? "Configure" : "Set up"}
              </Link>
            }
          >
            {r ? (
              <>
                <p style={{ margin: "0 0 12px", fontStyle: "italic", color: "var(--muted)" }}>“{r.greeting}”</p>
                <dl className="kv">
                  <dt>Personality</dt>
                  <dd style={{ textTransform: "capitalize" }}>{r.personality}</dd>
                  <dt>Voice</dt>
                  <dd className="mono">
                    {r.voice.provider} · {r.voice.voiceId}
                  </dd>
                  <dt>Brain</dt>
                  <dd className="mono">
                    {r.llm.provider} · {r.llm.model}
                  </dd>
                  <dt>Ears</dt>
                  <dd className="mono">{r.sttProvider}</dd>
                  <dt>Can do</dt>
                  <dd>{r.tools.map((t) => TOOL_LABELS[t]?.label ?? t).join(" · ") || "answer questions only"}</dd>
                  <dt>Call cap</dt>
                  <dd>{Math.round(r.maxCallSeconds / 60)} min</dd>
                </dl>
                <div style={{ marginTop: 14 }}>
                  <Link to={`/b/${biz.id}/test`} className="btn btn-primary sm">
                    Try a test call
                  </Link>
                </div>
              </>
            ) : (
              <p style={{ margin: 0, color: "var(--muted)" }}>
                Nothing answering this line yet. Set up the receptionist to compile the profile into a working prompt, pick a
                voice, and deploy it.
              </p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
