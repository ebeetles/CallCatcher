import { Link, NavLink, useParams } from "react-router-dom";
import { getBusiness, listAppointments, listMessages, useLoad, usePoll } from "../api";
import { useStatus } from "../App";
import { fmtPhone, openNow } from "../format";
import { ErrorNote, Eyebrow, Lamp, Spinner } from "../ui";
import type { LampState } from "../ui";
import OverviewTab from "./tabs/OverviewTab";
import ReceptionistTab from "./tabs/ReceptionistTab";
import ChatTab from "./tabs/ChatTab";
import CallsTab from "./tabs/CallsTab";
import InboxTab from "./tabs/InboxTab";

const TABS = [
  { key: "", label: "Overview" },
  { key: "receptionist", label: "Receptionist" },
  { key: "test", label: "Test call" },
  { key: "calls", label: "Calls" },
  { key: "inbox", label: "Inbox" },
] as const;

export default function BusinessDetail() {
  const { id = "", tab = "" } = useParams<{ id: string; tab?: string }>();
  const status = useStatus();

  const biz = useLoad(() => getBusiness(id), [id]);
  const msgs = useLoad(() => listMessages(id), [id]);
  const appts = useLoad(() => listAppointments(id), [id]);
  usePoll(() => {
    msgs.reload();
    appts.reload();
  }, 15000);

  if (biz.loading) return <Spinner label="Loading business…" />;
  if (biz.error || !biz.data)
    return (
      <div className="page">
        <ErrorNote msg={biz.error ?? "Business not found"} onRetry={biz.reload} />
        <Link to="/" className="btn btn-quiet">
          ← Back to businesses
        </Link>
      </div>
    );

  const b = biz.data;
  const open = openNow(b.hours, b.timezone);
  const lamp: LampState = b.receptionist && b.number ? "ok" : b.receptionist ? "amber" : "off";
  const newCount =
    (msgs.data?.filter((m) => m.status === "new").length ?? 0) +
    (appts.data?.filter((a) => a.status === "new").length ?? 0);

  const reloadAll = () => {
    biz.reload();
    msgs.reload();
    appts.reload();
  };

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <Eyebrow sec="SEC 02">
            Line record · <Link to="/">all businesses</Link>
          </Eyebrow>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Lamp state={lamp} title={lamp === "ok" ? "In service" : lamp === "amber" ? "No number attached" : "No receptionist"} />
            {b.name}
          </h1>
          <div className="sub">
            {b.industry || "—"} · {b.timezone}
            {open.label ? (
              <>
                {" · "}
                <span style={{ color: open.open ? "var(--ok)" : "var(--muted)" }}>{open.label}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="headactions">
          {b.number ? (
            <span className="chip mono bell" title={`Twilio status: ${b.number.status}`}>
              {fmtPhone(b.number.e164)}
            </span>
          ) : null}
          <Link to={`/b/${id}/edit`} className="btn btn-outline">
            Edit profile
          </Link>
        </div>
      </header>

      <nav className="tabrow">
        {TABS.map((t) => (
          <NavLink
            key={t.key}
            to={`/b/${id}${t.key ? `/${t.key}` : ""}`}
            end={t.key === ""}
            className={({ isActive }) => `tab${isActive ? " active" : ""}`}
          >
            {t.label}
            {t.key === "inbox" && newCount > 0 ? <span className="count">{newCount}</span> : null}
          </NavLink>
        ))}
      </nav>

      {tab === "" && <OverviewTab biz={b} status={status} reload={reloadAll} />}
      {tab === "receptionist" && <ReceptionistTab biz={b} status={status} reload={biz.reload} />}
      {tab === "test" && <ChatTab biz={b} onActivity={reloadAll} />}
      {tab === "calls" && <CallsTab bizId={id} />}
      {tab === "inbox" && (
        <InboxTab
          messages={msgs.data ?? []}
          appointments={appts.data ?? []}
          loading={msgs.loading || appts.loading}
          reload={() => {
            msgs.reload();
            appts.reload();
          }}
        />
      )}
    </div>
  );
}
