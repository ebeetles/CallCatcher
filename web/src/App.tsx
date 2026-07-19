import { createContext, useContext, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { getDashboardToken, getStatus, setDashboardToken, useLoad } from "./api";
import type { StatusResponse } from "./types";
import { Lamp, Spinner, ErrorNote } from "./ui";
import { AuthProvider, useAuth } from "./auth";
import { LoginPage, ResetPage, SignupPage } from "./pages/AuthPages";
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

/** Agency identity + sign-out at the bottom of the rail. */
function AccountRail({ status }: { status?: StatusResponse }) {
  const { config, signOut } = useAuth();
  const auth = status?.auth;
  if (!auth) return null;
  const onSignOut = async () => {
    if (config?.authMode === "supabase") await signOut();
    else {
      setDashboardToken("");
      window.location.reload();
    }
  };
  return (
    <div className="rail-system">
      <div className="rail-system-title">Account</div>
      <div className="sysrow" title={auth.email}>
        <Lamp state="ok" />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{auth.tenantName}</span>
      </div>
      <div className="sysrow">
        <span className="who" style={{ marginLeft: 0 }}>
          {auth.plan} plan
        </span>
      </div>
      {config?.authMode !== "open" ? (
        <button className="btn btn-quiet sm" style={{ marginTop: 6 }} onClick={onSignOut}>
          Sign out
        </button>
      ) : null}
    </div>
  );
}

/** Shown in legacy token mode when we don't have (or sent a wrong) DASHBOARD_TOKEN. */
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

/** The authenticated operator console (the original app shell). */
function Console() {
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
          <AccountRail status={status} />
        </aside>
        <main className="main">
          <Routes>
            <Route path="/" element={<BusinessList />} />
            <Route path="/new" element={<BusinessForm />} />
            <Route path="/b/:id/edit" element={<BusinessForm />} />
            <Route path="/b/:id/:tab?" element={<BusinessDetail />} />
            <Route path="/costs" element={<RateCard />} />
            {/* Recovery links land here with a live session — show the set-password form. */}
            <Route path="/reset" element={<ResetPage />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/signup" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </StatusCtx.Provider>
  );
}

function Gate() {
  const { config, configError, session, sessionReady, retryConfig } = useAuth();

  if (configError) {
    return (
      <div className="shell" style={{ alignItems: "center", justifyContent: "center", display: "flex", minHeight: "100vh" }}>
        <div style={{ maxWidth: 480, width: "100%" }}>
          <ErrorNote msg={`Can't reach the CallCatcher server: ${configError}`} onRetry={retryConfig} />
        </div>
      </div>
    );
  }
  if (!config || !sessionReady) {
    return (
      <div className="shell" style={{ alignItems: "center", justifyContent: "center", display: "flex", minHeight: "100vh" }}>
        <Spinner label="Connecting…" />
      </div>
    );
  }

  if (config.authMode === "supabase" && !session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/reset" element={<ResetPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return <Console />;
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
