import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useStatus } from "../App";
import { useAuth } from "../auth";
import { openBillingPortal, startCheckout } from "../api";
import { Chip, PageHead, Panel } from "../ui";

/**
 * Plan overview + upgrade grid. "Choose" starts a Stripe Checkout session;
 * "Manage billing" opens the Customer Portal. Without Stripe configured the
 * buttons explain what's missing instead of erroring.
 */
export default function BillingPage() {
  const status = useStatus();
  const { config } = useAuth();
  const [params] = useSearchParams();
  const [busyPlan, setBusyPlan] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const auth = status?.auth;
  const plans = config?.plans ?? [];
  const billingOn = auth?.billing.enabled ?? config?.billingEnabled ?? false;
  const checkoutOutcome = params.get("checkout");

  const choose = async (planId: string) => {
    setBusyPlan(planId);
    setError(undefined);
    try {
      const { url } = await startCheckout(planId);
      window.location.href = url; // off to Stripe Checkout
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyPlan(undefined);
    }
  };

  const manageBilling = async () => {
    setError(undefined);
    try {
      const { url } = await openBillingPortal();
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <PageHead
        sec="05"
        eyebrow="Subscription"
        title="Billing"
        sub={auth ? `${auth.tenantName} · ${auth.plan} plan` : undefined}
        actions={
          auth?.billing.hasAccount && billingOn ? (
            <button className="btn btn-quiet" onClick={manageBilling}>
              Manage billing
            </button>
          ) : undefined
        }
      />

      {checkoutOutcome === "success" ? (
        <div className="note" style={{ marginBottom: 14 }}>
          🎉 Subscription active — thanks! It can take a few seconds for the plan below to update; refresh if needed.
        </div>
      ) : checkoutOutcome === "canceled" ? (
        <div className="note" style={{ marginBottom: 14 }}>
          Checkout canceled — no changes made.
        </div>
      ) : null}

      {auth?.usage.trialDaysLeft !== undefined && auth.usage.active ? (
        <div className="note" style={{ marginBottom: 14 }}>
          Free trial — <b>{auth.usage.trialDaysLeft} day{auth.usage.trialDaysLeft === 1 ? "" : "s"} left</b>. Pick a plan
          below to keep your receptionists answering after it ends.
        </div>
      ) : null}
      {auth && !auth.usage.active ? (
        <div className="note err" style={{ marginBottom: 14 }}>
          Plan inactive ({auth.usage.blockedReason}) — subscribing reactivates your receptionists immediately.
        </div>
      ) : null}
      {error ? (
        <div className="note err" role="alert" style={{ marginBottom: 14 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        {plans.map((p) => {
          const current = auth?.plan === p.id && auth?.planStatus === "active";
          return (
            <Panel
              key={p.id}
              title={
                <>
                  {p.label} {current ? <Chip tone="ok">current</Chip> : null}
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
              {billingOn ? (
                <button className="btn btn-primary" disabled={current || busyPlan !== undefined} onClick={() => choose(p.id)}>
                  {current ? "Current plan" : busyPlan === p.id ? "Redirecting…" : `Choose ${p.label}`}
                </button>
              ) : (
                <button className="btn btn-primary" disabled title="Set STRIPE_* env vars on the server to enable checkout">
                  {current ? "Current plan" : `Choose ${p.label}`}
                </button>
              )}
            </Panel>
          );
        })}
      </div>
      {!billingOn ? (
        <p style={{ marginTop: 14 }} className="hint">
          Checkout is disabled: the server has no Stripe configuration (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
          STRIPE_PRICE_*). Plans and usage limits are still enforced against the plan set on your account.
        </p>
      ) : null}
    </>
  );
}
