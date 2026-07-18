import { useState } from "react";
import { getCall, listCalls, useLoad, usePoll } from "../../api";
import { fmtAgo, fmtDateTime, fmtDur, fmtPhone, fmtTokens, money } from "../../format";
import type { CallRecord } from "../../types";
import { Chip, Empty, ErrorNote, Lamp, Panel, Spinner } from "../../ui";

const ROLE_LABEL: Record<string, string> = { assistant: "AI", user: "CALLER", tool: "TOOL", system: "SYS" };

function statusLamp(c: CallRecord) {
  if (c.status === "in-progress") return <Lamp state="live" pulse title="In progress" />;
  if (c.status === "failed") return <Lamp state="amber" title="Failed" />;
  return <Lamp state="off" title="Completed" />;
}

function TranscriptPane({ callId }: { callId: string }) {
  const { data, error, loading, reload } = useLoad(() => getCall(callId), [callId]);
  if (loading) return <Spinner label="Loading transcript…" />;
  if (error || !data) return <ErrorNote msg={error ?? "Call not found"} onRetry={reload} />;
  const m = data.call.metrics;
  return (
    <Panel
      title={`Transcript · ${fmtDateTime(data.call.startedAt)}`}
      actions={data.call.endedReason ? <Chip>{data.call.endedReason}</Chip> : undefined}
    >
      {m ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          <Chip mono title="Turns">{m.turns} turns</Chip>
          {m.interruptions > 0 ? <Chip mono title="Caller interrupted the receptionist">{m.interruptions} barge-ins</Chip> : null}
          <Chip mono title="LLM tokens in/out">
            {fmtTokens(m.llmInputTokens)} in · {fmtTokens(m.llmOutputTokens)} out
          </Chip>
          {m.avgResponseMs !== undefined ? <Chip mono title="Average response latency">~{m.avgResponseMs}ms reply</Chip> : null}
          <Chip mono tone="bell" title="Estimated provider cost for this call">
            {money(m.estimatedCostUsd)}
          </Chip>
        </div>
      ) : null}
      <div className="transcript">
        {data.turns.map((t) => (
          <div key={t.id} className={`turn ${t.role}`}>
            <div className="who">{ROLE_LABEL[t.role] ?? t.role}</div>
            <div className="what">
              {t.content}
              {t.truncated ? <Chip tone="ring" title="Caller spoke over this reply"> cut off</Chip> : null}
              {t.latency?.totalMs !== undefined ? <div className="t-meta">{t.latency.totalMs}ms</div> : null}
            </div>
          </div>
        ))}
        {data.turns.length === 0 ? <p style={{ color: "var(--muted)" }}>No turns recorded.</p> : null}
      </div>
    </Panel>
  );
}

export default function CallsTab({ bizId }: { bizId: string }) {
  const { data, error, loading, reload } = useLoad(() => listCalls(bizId), [bizId]);
  const [selected, setSelected] = useState<string | undefined>();
  usePoll(reload, 10000);

  if (loading && !data) return <Spinner label="Loading calls…" />;
  if (error) return <ErrorNote msg={error} onRetry={reload} />;
  if (!data || data.length === 0)
    return (
      <Empty
        title="No calls on record"
        body="Calls land here with full transcripts, latency, and cost — try a test call, or dial the number once it's attached."
      />
    );

  return (
    <div className="twopane">
      <Panel title={`Call log · ${data.length}`} tight actions={<button className="btn btn-quiet sm" onClick={reload}>Refresh</button>}>
        <table className="table">
          <thead>
            <tr>
              <th></th>
              <th>When</th>
              <th>Via</th>
              <th>From</th>
              <th className="num">Length</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr
                key={c.id}
                className={`click${selected === c.id ? " selected" : ""}`}
                onClick={() => setSelected(c.id)}
                title={fmtDateTime(c.startedAt)}
              >
                <td style={{ width: 30 }}>{statusLamp(c)}</td>
                <td>{fmtAgo(c.startedAt)}</td>
                <td>
                  <Chip>{c.channel}</Chip>
                </td>
                <td className="mono">{c.fromNumber ? fmtPhone(c.fromNumber) : "—"}</td>
                <td className="mono num">{fmtDur(c.durationSec)}</td>
                <td className="mono num">{money(c.metrics?.estimatedCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <div>
        {selected ? (
          <TranscriptPane callId={selected} />
        ) : (
          <Panel title="Transcript">
            <p style={{ color: "var(--muted)", margin: 0 }}>Select a call to read the transcript and its metrics.</p>
          </Panel>
        )}
      </div>
    </div>
  );
}
