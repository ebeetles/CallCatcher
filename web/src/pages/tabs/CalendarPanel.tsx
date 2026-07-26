import { useState } from "react";
import { connectCalendar, disconnectCalendar, getCalendarStatus, useLoad } from "../../api";
import type { BusinessSummary } from "../../types";
import { Chip, ErrorNote, Panel, Spinner } from "../../ui";

/**
 * Operator-facing Google Calendar setup for a single business. Because reading a
 * client's availability and writing to their calendar needs THEIR Google
 * consent, the main flow is a signed link you send the client (they click once).
 * "Connect now" opens the same link if you're setting it up together. In
 * zero-config/mock mode (no Google app), connecting is instant and simulated.
 */
export default function CalendarPanel({ biz }: { biz: BusinessSummary }) {
  const status = useLoad(() => getCalendarStatus(biz.id), [biz.id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [link, setLink] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  const s = status.data;

  const mint = async (): Promise<string | undefined> => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await connectCalendar(biz.id);
      if (r.connected) {
        status.reload();
        return undefined; // mock/instant connect
      }
      setLink(r.url);
      return r.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const connectNow = async () => {
    const url = await mint();
    if (url) window.open(url, "_blank", "noopener");
  };

  const copyLink = async () => {
    const url = link ?? (await mint());
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Couldn't copy — select and copy the link below manually.");
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await disconnectCalendar(biz.id);
      setLink(undefined);
      status.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Google Calendar" lamp={s?.connected ? "ok" : "off"}>
      {status.loading && !s ? <Spinner /> : null}

      {s?.connected ? (
        <>
          <p style={{ margin: "0 0 10px" }}>
            <Chip tone="ok">Connected</Chip>{" "}
            {s.mock ? (
              <span style={{ color: "var(--muted)" }}>simulated — no Google app configured, so bookings are mocked.</span>
            ) : (
              <span style={{ color: "var(--muted)" }}>
                {s.accountEmail ? <>as <strong>{s.accountEmail}</strong> · </> : null}
                calendar <span className="mono">{s.calendarId}</span>
              </span>
            )}
          </p>
          <p style={{ color: "var(--muted)", margin: "0 0 12px", fontSize: 14 }}>
            The receptionist now checks this calendar for openings and books appointments on it directly — no callback needed.
          </p>
          <button className="btn btn-outline sm" onClick={disconnect} disabled={busy}>
            {busy ? "Working…" : "Disconnect"}
          </button>
        </>
      ) : s ? (
        <>
          <p style={{ color: "var(--muted)", margin: "0 0 12px", fontSize: 14 }}>
            Connect the client's Google Calendar so the receptionist can book appointments straight onto it and check real
            availability. {s.mock ? "" : "Send them the link below — they approve once, no password needed on your end."}
          </p>
          {s.mock ? (
            <div className="note warn" style={{ marginTop: 0, marginBottom: 12 }}>
              Demo mode — no Google app is configured, so connecting is simulated. Set <span className="mono">GOOGLE_CLIENT_ID</span>{" "}
              / <span className="mono">GOOGLE_CLIENT_SECRET</span> for real calendars.
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary sm" onClick={connectNow} disabled={busy}>
              {busy ? "Working…" : s.mock ? "Connect (simulated)" : "Connect now"}
            </button>
            {!s.mock ? (
              <button className="btn btn-outline sm" onClick={copyLink} disabled={busy}>
                {copied ? "Copied ✓" : "Copy client link"}
              </button>
            ) : null}
          </div>
          {link && !s.mock ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: "var(--faint)", fontSize: 12, marginBottom: 4 }}>
                Send this to the client — valid for 7 days:
              </div>
              <input className="input mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            </div>
          ) : null}
        </>
      ) : null}

      {err ? <ErrorNote msg={err} /> : null}
    </Panel>
  );
}
