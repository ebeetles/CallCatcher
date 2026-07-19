import { useStatus } from "../App";
import { useAuth } from "../auth";
import { PageHead, Panel, Chip } from "../ui";

/**
 * Plan overview + upgrade grid. Checkout/portal buttons wire up to
 * /api/billing/* (Stripe) — until the server has Stripe keys they explain
 * what's missing instead of erroring.
 */
export default function BillingPage() {
  const status = useStatus();
  const { config } = useAuth();
  const auth = status?.auth;
  const plans = config?.plans ?? [];

  return (
    <>
      <PageHead sec="05" eyebrow="Subscription" title="Billing" sub={auth ? `${auth.tenantName} · ${auth.plan} plan` : undefined} />

      {auth?.usage.trialDaysLeft !== undefined && auth.usage.active ? (
        <div className="note" style={{ marginBottom: 14 }}>
          Free trial — <b>{auth.usage.trialDaysLeft} day{auth.usage.trialDaysLeft === 1 ? "" : "s"} left</b>.
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        {plans.map((p) => (
          <Panel
            key={p.id}
            title={
              <>
                {p.label} {auth?.plan === p.id ? <Chip tone="ok">current</Chip> : null}
              </>
            }
          >
            <div style={{ fontSize: 28, fontWeight: 700 }}>
              ${p.priceUsd}
              <span style={{ fontSize: 14, fontWeight: 400 }}>/mo</span>
            </div>
            <p style={{ margin: "8px 0" }}>{p.blurb}</p>
            <ul style={{ margin: "8px 0 12px 18px" }}>
              <li>
                {p.maxBusinesses} business{p.maxBusinesses === 1 ? "" : "es"}
              </li>
              <li>{p.includedMinutes.toLocaleString()} call minutes / month</li>
              <li>{p.elevenlabs ? "Premium ElevenLabs voices" : "Standard voices"}</li>
            </ul>
            <button className="btn btn-primary" disabled title="Stripe billing arrives with the next update">
              {auth?.plan === p.id ? "Current plan" : "Choose " + p.label}
            </button>
          </Panel>
        ))}
      </div>
      <p style={{ marginTop: 14 }} className="hint">
        Online checkout is being wired up (Stripe). Plans and limits above are live — usage is
        enforced against your current plan today.
      </p>
    </>
  );
}
