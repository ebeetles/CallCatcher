import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { BrandMark } from "../ui";

/** Centered card shell shared by the login/signup/reset screens. */
function AuthShell({ title, sub, children, footer }: { title: string; sub?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="shell" style={{ alignItems: "center", justifyContent: "center", display: "flex", minHeight: "100vh" }}>
      <div style={{ maxWidth: 420, width: "100%" }}>
        <Link to="/" className="brand" style={{ display: "inline-flex", marginBottom: 14 }}>
          <BrandMark />
          CallCatcher
        </Link>
        <div className="panel">
          <div className="panel-h">
            <h2>{title}</h2>
          </div>
          <div className="panel-b">
            {sub ? <p style={{ marginBottom: 12 }}>{sub}</p> : null}
            {children}
          </div>
        </div>
        {footer ? <p style={{ marginTop: 12, textAlign: "center" }}>{footer}</p> : null}
      </div>
    </div>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, onSubmit };
}

const ErrLine = ({ msg }: { msg?: string }) => (msg ? <div className="note err" role="alert" style={{ marginTop: 10 }}>{msg}</div> : null);

/** Google's "G" mark, inline so it needs no external asset (CSP-safe). */
const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
  </svg>
);

/**
 * "Continue with Google" — Supabase's OAuth flow. Redirects to Google, then
 * back to the app origin; supabase-js (detectSessionInUrl) picks up the session
 * on return and AuthProvider's onAuthStateChange drops the user into the console.
 */
function GoogleButton({ label }: { label: string }) {
  const { supabase } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const onClick = async () => {
    if (!supabase) {
      setError("Auth not configured");
      return;
    }
    setBusy(true);
    setError(undefined);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    // On success the browser navigates to Google, so we only get here on error.
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn btn-outline" onClick={onClick} disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
        <GoogleMark />
        {busy ? "Redirecting…" : label}
      </button>
      <ErrLine msg={error} />
    </>
  );
}

const OrDivider = () => <div className="auth-or">or</div>;

export function LoginPage() {
  const { supabase } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, onSubmit } = useSubmit(async () => {
    if (!supabase) throw new Error("Auth not configured");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    navigate("/", { replace: true });
  });

  return (
    <AuthShell
      title="Sign in"
      sub="Your agency dashboard: every client, receptionist, and call in one place."
      footer={
        <>
          New here? <Link to="/signup">Create your agency account</Link> · <Link to="/reset">Forgot password</Link>
        </>
      }
    >
      <GoogleButton label="Sign in with Google" />
      <OrDivider />
      <form onSubmit={onSubmit}>
        <div className="field">
          <span className="label">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <span className="label">Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <ErrLine msg={error} />
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { supabase } = useAuth();
  const navigate = useNavigate();
  const [agency, setAgency] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const { busy, error, onSubmit } = useSubmit(async () => {
    if (!supabase) throw new Error("Auth not configured");
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { agency_name: agency.trim() } },
    });
    if (error) throw new Error(error.message);
    // With email confirmation on (Supabase default) there's no session yet.
    if (data.session) navigate("/", { replace: true });
    else setNeedsConfirm(true);
  });

  if (needsConfirm) {
    return (
      <AuthShell title="Check your email" footer={<Link to="/login">Back to sign in</Link>}>
        <p>
          We sent a confirmation link to <b>{email}</b>. Click it, then sign in — your 14-day free
          trial starts the moment you're in.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your agency account"
      sub="14-day free trial. Build a working AI receptionist in minutes — no card required."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <GoogleButton label="Sign up with Google" />
      <OrDivider />
      <form onSubmit={onSubmit}>
        <div className="field">
          <span className="label">Agency name</span>
          <input value={agency} onChange={(e) => setAgency(e.target.value)} placeholder="Acme Answering Co." autoFocus required />
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <span className="label">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <span className="label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
          <span className="hint">At least 8 characters.</span>
        </div>
        <ErrLine msg={error} />
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? "Creating account…" : "Start free trial"}
        </button>
      </form>
    </AuthShell>
  );
}

export function ResetPage() {
  const { supabase, session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);

  const request = useSubmit(async () => {
    if (!supabase) throw new Error("Auth not configured");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset`,
    });
    if (error) throw new Error(error.message);
    setSent(true);
  });

  const update = useSubmit(async () => {
    if (!supabase) throw new Error("Auth not configured");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(error.message);
    navigate("/", { replace: true });
  });

  // Arriving from the reset email logs the user into a recovery session —
  // show the "set a new password" form instead of the request form.
  if (session) {
    return (
      <AuthShell title="Set a new password">
        <form onSubmit={update.onSubmit}>
          <div className="field">
            <span className="label">New password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              autoFocus
              required
            />
          </div>
          <ErrLine msg={update.error} />
          <button className="btn btn-primary" type="submit" disabled={update.busy} style={{ marginTop: 12 }}>
            {update.busy ? "Saving…" : "Save password"}
          </button>
        </form>
      </AuthShell>
    );
  }

  if (sent) {
    return (
      <AuthShell title="Check your email" footer={<Link to="/login">Back to sign in</Link>}>
        <p>
          If an account exists for <b>{email}</b>, a reset link is on its way.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Reset password" footer={<Link to="/login">Back to sign in</Link>}>
      <form onSubmit={request.onSubmit}>
        <div className="field">
          <span className="label">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        </div>
        <ErrLine msg={request.error} />
        <button className="btn btn-primary" type="submit" disabled={request.busy} style={{ marginTop: 12 }}>
          {request.busy ? "Sending…" : "Send reset link"}
        </button>
      </form>
    </AuthShell>
  );
}
