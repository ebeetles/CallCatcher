import { useState } from "react";
import { setAppointmentStatus, setMessageStatus } from "../../api";
import { fmtAgo, fmtPhone } from "../../format";
import type { AppointmentRequest, MessageRecord } from "../../types";
import { Chip, ErrorNote, Panel, Spinner } from "../../ui";

function byNewFirst<T extends { status: string; createdAt: string }>(a: T, b: T): number {
  const an = a.status === "new" ? 0 : 1;
  const bn = b.status === "new" ? 0 : 1;
  if (an !== bn) return an - bn;
  return b.createdAt.localeCompare(a.createdAt);
}

export default function InboxTab({
  messages,
  appointments,
  loading,
  reload,
}: {
  messages: MessageRecord[];
  appointments: AppointmentRequest[];
  loading: boolean;
  reload: () => void;
}) {
  const [err, setErr] = useState<string | undefined>();
  const act = async (fn: () => Promise<unknown>) => {
    setErr(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading && messages.length === 0 && appointments.length === 0) return <Spinner label="Loading inbox…" />;

  return (
    <div>
      {err ? <ErrorNote msg={err} /> : null}
      <div className="twopane">
        <Panel title={`Messages · ${messages.filter((m) => m.status === "new").length} new`} tight>
          {messages.length === 0 ? (
            <p style={{ color: "var(--muted)", padding: 16, margin: 0 }}>
              When the receptionist takes a message, it lands here with the caller's name and callback number.
            </p>
          ) : (
            <table className="table">
              <tbody>
                {[...messages].sort(byNewFirst).map((m) => (
                  <tr key={m.id} style={m.status === "handled" ? { opacity: 0.55 } : undefined}>
                    <td>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                        <strong>{m.callerName || "Unknown caller"}</strong>
                        {m.callbackNumber ? <span className="mono" style={{ fontSize: 12.5, color: "var(--bell-deep)" }}>{fmtPhone(m.callbackNumber)}</span> : null}
                        {m.urgency === "urgent" ? <Chip tone="ring">URGENT</Chip> : null}
                        <span style={{ color: "var(--faint)", fontSize: 12 }}>{fmtAgo(m.createdAt)}</span>
                      </div>
                      <div>{m.content}</div>
                    </td>
                    <td className="num" style={{ width: 120 }}>
                      {m.status === "new" ? (
                        <button className="btn btn-outline sm" onClick={() => act(() => setMessageStatus(m.id, "handled"))}>
                          Mark handled
                        </button>
                      ) : (
                        <button className="btn btn-quiet sm" onClick={() => act(() => setMessageStatus(m.id, "new"))}>
                          Reopen
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={`Appointment requests · ${appointments.filter((a) => a.status === "new").length} new`} tight>
          {appointments.length === 0 ? (
            <p style={{ color: "var(--muted)", padding: 16, margin: 0 }}>
              Appointment requests the receptionist collects show up here for you to confirm with the business.
            </p>
          ) : (
            <table className="table">
              <tbody>
                {[...appointments].sort(byNewFirst).map((a) => (
                  <tr key={a.id} style={a.status !== "new" ? { opacity: 0.65 } : undefined}>
                    <td>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                        <strong>{a.name || "Unknown caller"}</strong>
                        {a.phone ? <span className="mono" style={{ fontSize: 12.5, color: "var(--bell-deep)" }}>{fmtPhone(a.phone)}</span> : null}
                        {a.status === "confirmed" ? <Chip tone="ok">Confirmed</Chip> : null}
                        {a.status === "declined" ? <Chip>Declined</Chip> : null}
                        <span style={{ color: "var(--faint)", fontSize: 12 }}>{fmtAgo(a.createdAt)}</span>
                      </div>
                      <div>
                        {a.service ? <strong>{a.service}</strong> : "Appointment"}
                        {a.preferredTimes ? <> · {a.preferredTimes}</> : null}
                      </div>
                      {a.notes ? <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{a.notes}</div> : null}
                    </td>
                    <td className="num" style={{ width: 150 }}>
                      {a.status === "new" ? (
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button className="btn btn-primary sm" onClick={() => act(() => setAppointmentStatus(a.id, "confirmed"))}>
                            Confirm
                          </button>
                          <button className="btn btn-quiet sm" onClick={() => act(() => setAppointmentStatus(a.id, "declined"))}>
                            Decline
                          </button>
                        </span>
                      ) : (
                        <button className="btn btn-quiet sm" onClick={() => act(() => setAppointmentStatus(a.id, "new"))}>
                          Reset
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
