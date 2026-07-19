import { Link } from "react-router-dom";
import { getUsage, useLoad } from "../api";
import { Chip, ErrorNote, PageHead, Panel, Spinner, Stat } from "../ui";

/** Fraction → percent string, clamped for the meter bar. */
const pct = (used: number, included: number | null): number =>
  included === null || included <= 0 ? 0 : Math.min(100, Math.round((used / included) * 100));

export default function UsagePage() {
  const { data, error, loading, reload } = useLoad(getUsage, []);

  if (loading && !data) return <Spinner label="Loading usage…" />;
  if (error) return <ErrorNote msg={error} onRetry={reload} />;
  if (!data) return null;

  const used = data.totals.minutes;
  const included = data.plan.includedMinutes;
  const percent = pct(used, included);
  const warn = included !== null && percent >= 80;

  return (
    <>
      <PageHead
        sec="04"
        eyebrow="This month"
        title="Usage"
        sub={`${data.month} · ${data.plan.label} plan`}
        actions={
          <Link to="/billing" className="btn btn-quiet">
            Manage plan
          </Link>
        }
      />

      {data.trialDaysLeft !== undefined && data.active ? (
        <div className="note" style={{ marginBottom: 14 }}>
          Free trial — <b>{data.trialDaysLeft} day{data.trialDaysLeft === 1 ? "" : "s"} left</b>. Pick a plan on the{" "}
          <Link to="/billing">billing page</Link> to keep your receptionists answering after it ends.
        </div>
      ) : null}
      {!data.active ? (
        <ErrorNote msg={`Plan inactive (${data.blockedReason ?? "unknown"}) — calls are paused. Visit billing to reactivate.`} />
      ) : warn ? (
        <div className="note err" style={{ marginBottom: 14 }}>
          {percent >= 100
            ? "Included minutes exhausted — inbound calls get an unavailable message until you upgrade or the month rolls over."
            : `You've used ${percent}% of this month's included minutes.`}
        </div>
      ) : null}

      <div className="stats-row" style={{ display: "flex", gap: 24, marginBottom: 18 }}>
        <Stat value={data.totals.calls} label="calls" />
        <Stat
          value={included === null ? `${used}` : `${used} / ${included}`}
          label="minutes"
          sub={included === null ? "unlimited" : `${percent}% used`}
        />
        <Stat value={`$${data.totals.estCostUsd.toFixed(2)}`} label="est. provider cost" sub="what the calls cost in AI + telephony" />
      </div>

      {included !== null ? (
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: "var(--line, #e5e5e0)",
              overflow: "hidden",
            }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              style={{
                width: `${percent}%`,
                height: "100%",
                background: percent >= 100 ? "var(--bad, #b3392e)" : percent >= 80 ? "var(--amber, #b98a1c)" : "var(--accent, #2b5d8c)",
              }}
            />
          </div>
        </div>
      ) : null}

      <Panel title="By business" tight>
        {data.perBusiness.length === 0 ? (
          <p style={{ padding: 12 }}>No businesses yet this month.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Business</th>
                <th>Calls</th>
                <th>Minutes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.perBusiness.map((b) => (
                <tr key={b.businessId}>
                  <td>{b.name}</td>
                  <td>{b.calls}</td>
                  <td>{b.minutes}</td>
                  <td>
                    <Link to={`/b/${b.businessId}/calls`}>
                      <Chip>calls →</Chip>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
