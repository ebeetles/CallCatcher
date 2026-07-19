import { useState } from "react";
import { adminListTenants, adminSetTenantStatus, useLoad } from "../api";
import { Chip, ErrorNote, PageHead, Panel, Spinner } from "../ui";

/** Platform-admin roster: every agency on the box, its plan, usage, and a kill switch. */
export default function AdminPage() {
  const { data, error, loading, reload } = useLoad(adminListTenants, []);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const act = async (id: string, action: "suspend" | "reactivate") => {
    setBusy(id);
    setActionError(undefined);
    try {
      await adminSetTenantStatus(id, action);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  if (loading && !data) return <Spinner label="Loading tenants…" />;
  if (error) return <ErrorNote msg={error} onRetry={reload} />;

  return (
    <>
      <PageHead sec="09" eyebrow="Platform" title="Tenants" sub={`${data?.length ?? 0} agencies on this server`} />
      {actionError ? <ErrorNote msg={actionError} /> : null}
      <Panel tight>
        <table className="table">
          <thead>
            <tr>
              <th>Agency</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Businesses</th>
              <th>Min (mo)</th>
              <th>Est. cost</th>
              <th>Twilio</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.id}>
                <td>
                  <b>{t.name}</b>
                  <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>{t.id}</div>
                </td>
                <td>{t.plan}</td>
                <td>
                  <Chip tone={t.planStatus === "active" ? "ok" : t.planStatus === "suspended" ? "bell" : "amber"}>
                    {t.planStatus}
                  </Chip>
                </td>
                <td>{t.businesses}</td>
                <td>{Math.round(t.month.seconds / 60)}</td>
                <td>${t.month.estCostUsd.toFixed(2)}</td>
                <td>{t.twilioSubaccountSid ? <Chip tone="ok">subaccount</Chip> : <Chip>master</Chip>}</td>
                <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                <td>
                  {t.planStatus === "suspended" ? (
                    <button className="btn btn-quiet sm" disabled={busy === t.id} onClick={() => act(t.id, "reactivate")}>
                      Reactivate
                    </button>
                  ) : (
                    <button className="btn btn-quiet sm" disabled={busy === t.id} onClick={() => act(t.id, "suspend")}>
                      Suspend
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
