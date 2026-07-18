import type { ReactNode } from "react";

export type LampState = "ok" | "amber" | "live" | "bell" | "off";

export function Lamp({ state, pulse, title }: { state: LampState; pulse?: boolean; title?: string }) {
  const cls = state === "off" ? "" : ` ${state}`;
  return <span className={`lamp${cls}${pulse ? " pulse" : ""}`} title={title} aria-hidden="true" />;
}

export function StatusLine({ state, pulse, children }: { state: LampState; pulse?: boolean; children: ReactNode }) {
  return (
    <span className="status-line">
      <Lamp state={state} pulse={pulse} />
      {children}
    </span>
  );
}

export function Eyebrow({ sec, children }: { sec: string; children: ReactNode }) {
  return (
    <p className="eyebrow">
      <b>{sec}</b> · {children}
    </p>
  );
}

export function PageHead({
  sec,
  eyebrow,
  title,
  sub,
  actions,
}: {
  sec: string;
  eyebrow: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="pagehead">
      <div>
        <Eyebrow sec={sec}>{eyebrow}</Eyebrow>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {actions ? <div className="headactions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  lamp,
  actions,
  children,
  tight,
}: {
  title?: ReactNode;
  lamp?: LampState;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section className="panel">
      {title !== undefined ? (
        <div className="panel-h">
          {lamp ? <Lamp state={lamp} /> : null}
          <h2>{title}</h2>
          <span className="spacer" />
          {actions}
        </div>
      ) : null}
      <div className={`panel-b${tight ? " tight" : ""}`}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Chip({
  tone,
  mono,
  children,
  title,
}: {
  tone?: "ok" | "amber" | "ring" | "bell";
  mono?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip${tone ? ` ${tone}` : ""}${mono ? " mono" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function Stat({ value, label, sub }: { value: ReactNode; label: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading-line" role="status">
      <span className="spin" />
      {label ?? "Loading…"}
    </div>
  );
}

export function ErrorNote({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div className="note err" role="alert">
      {msg}
      {onRetry ? (
        <>
          {" "}
          <button className="btn btn-quiet sm" onClick={onRetry}>
            Retry
          </button>
        </>
      ) : null}
    </div>
  );
}

export function Empty({
  title,
  body,
  children,
}: {
  title: string;
  body?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-dial">● ● ●</div>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {children ? <div className="actions">{children}</div> : null}
    </div>
  );
}
