import { createContext, useContext, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { getDashboardToken, getStatus, setDashboardToken, useLoad } from "./api";
import type { StatusResponse } from "./types";
import { Lamp } from "./ui";
import BusinessList from "./pages/BusinessList";
import BusinessForm from "./pages/BusinessForm";
import BusinessDetail from "./pages/BusinessDetail";
import RateCard from "./pages/RateCard";

const StatusCtx = createContext<{ status?: StatusResponse; reload: () => void }>({ reload: () => {} });

export function useStatus(): StatusResponse | undefined {
  return useContext(StatusCtx).status;
}

function SystemRail({ status }: { status?: StatusResponse }) {
  if (!status) return null;
  const p = status.providers;
  const d = status.defaults;
  const rows: Array<{ label: string; ok: boolean; who: string }> = [
    { label: "Brain", ok: d.llm !== "mock", who: d.llm },
    { label: "Ears", ok: d.stt !== "mock", who: d.stt },
    { label: "Voice", ok: d.tts !== "mock", who: d.tts },
    { label: "Phone", ok: p.telephony.twilio, who: p.telephony.twilio ? "twilio" : "none" },
  ];
  return (
    <div className="rail-system">
      <div className="rail-system-title">System</div>
      {p.mockMode ? (
        <div className="sysrow">
          <Lamp state="amber" />
          Mock mode on
        </div>
      ) : null}
      {rows.map((r) => (
        <div className="sysrow" key={r.label} title={r.ok ? `${r.label}: ${r.who}` : `${r.label}: no key — using mock`}>
          <Lamp state={r.ok ? "ok" : "off"} />
          {r.label}
          <span className="who">{r.who}</span>
        </div>
      ))}
    </div>
  );
}

/** Shown when the server has DASHBOARD_TOKEN set and we don't have (or sent a wrong) token. */
function TokenGate({ retry }: { retry: () => void }) {
  const [value, setValue] = useState(getDashboardToken());
  return (
    <div className="shell" style={{ alignItems: "center", justifyContent: "center", display: "flex", minHeight: "100vh" }}>
      <form
        className="panel"
        style={{ maxWidth: 420, width: "100%" }}
        onSubmit={(e) => {
          e.preventDefault();
          setDashboardToken(value.trim());
          retry();
        }}
      >
        <div className="panel-h">
          <h2>Access token required</h2>
        </div>
        <div className="panel-b">
          <p style={{ marginBottom: 12 }}>
            This server is protected. Paste the <code>DASHBOARD_TOKEN</code> from its <code>.env</code>.
          </p>
          <div className="field">
            <span className="label">Token</span>
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </div>
          <button className="btn btn-primary" type="submit" style={{ marginTop: 12 }}>
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const { data: status, error, reload } = useLoad(getStatus, []);
  if (error === "unauthorized") return <TokenGate retry={reload} />;
  return (
    <StatusCtx.Provider value={{ status, reload }}>
      <div className="shell">
        <aside className="rail">
          <Link to="/" className="brand">
            <span className="brand-mark" />
            CallCatcher
          </Link>
          <div className="brand-sub">Console</div>
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
              Businesses
            </NavLink>
            <NavLink to="/costs" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
              Rate card
            </NavLink>
            <NavLink to="/new" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
              New business
            </NavLink>
          </nav>
          <div className="rail-spacer" />
          <SystemRail status={status} />
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<BusinessList />} />
            <Route path="/new" element={<BusinessForm />} />
            <Route path="/b/:id/edit" element={<BusinessForm />} />
            <Route path="/b/:id/:tab?" element={<BusinessDetail />} />
            <Route path="/costs" element={<RateCard />} />
          </Routes>
        </main>
      </div>
    </StatusCtx.Provider>
  );
}
