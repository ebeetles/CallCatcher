import { useEffect, useMemo, useState } from "react";
import { deployReceptionist, getVoices, listReceptionists, previewReceptionist, useLoad } from "../../api";
import { fmtDateTime } from "../../format";
import type { BusinessSummary, Personality, PromptPreview, ReceptionistDraft, StatusResponse } from "../../types";
import { ALL_TOOLS, TOOL_LABELS } from "../../types";
import { Chip, ErrorNote, Field, Lamp, Panel, Spinner } from "../../ui";
import CalendarPanel from "./CalendarPanel";

const PERSONALITIES: Array<{ id: Personality; blurb: string }> = [
  { id: "friendly", blurb: "Upbeat and casual — good for salons, gyms, family practices." },
  { id: "professional", blurb: "Crisp and businesslike — law, finance, medical." },
  { id: "warm", blurb: "Gentle and reassuring — care, counseling, vets." },
  { id: "efficient", blurb: "Short answers, no small talk — trades and dispatch." },
];

interface Draft {
  personality: Personality;
  voiceProvider: string;
  voiceId: string;
  llmProvider: string;
  llmModel: string;
  maxTokens: number;
  sttProvider: string;
  tools: string[];
  maxCallMinutes: number;
  extraInstructions: string;
  useAi: boolean;
}

export default function ReceptionistTab({
  biz,
  status,
  reload,
}: {
  biz: BusinessSummary;
  status?: StatusResponse;
  reload: () => void;
}) {
  const voices = useLoad(getVoices, []);
  const versions = useLoad(() => listReceptionists(biz.id), [biz.id]);

  const ttsProviders = useMemo(
    () => Object.entries(status?.providers.tts ?? { mock: true }).filter(([, ok]) => ok).map(([id]) => id),
    [status]
  );
  const llmProviders = useMemo(
    () => Object.entries(status?.providers.llm ?? { mock: true }).filter(([, ok]) => ok).map(([id]) => id),
    [status]
  );
  const sttProviders = useMemo(
    () => Object.entries(status?.providers.stt ?? { mock: true }).filter(([, ok]) => ok).map(([id]) => id),
    [status]
  );

  const modelFor = (provider: string) =>
    provider === "anthropic" ? status?.callModels.anthropic ?? "claude-haiku-4-5" : provider === "openai" ? status?.callModels.openai ?? "gpt-4o-mini" : "mock";

  const active = biz.receptionist;
  const [draft, setDraft] = useState<Draft>(() => ({
    personality: active?.personality ?? "friendly",
    voiceProvider: active?.voice.provider ?? status?.defaults.tts ?? "mock",
    voiceId: active?.voice.voiceId ?? "",
    llmProvider: active?.llm.provider ?? status?.defaults.llm ?? "mock",
    llmModel: active?.llm.model ?? modelFor(active?.llm.provider ?? status?.defaults.llm ?? "mock"),
    maxTokens: active?.llm.maxTokens ?? 512,
    sttProvider: active?.sttProvider ?? status?.defaults.stt ?? "mock",
    tools: active?.tools ?? [...ALL_TOOLS],
    maxCallMinutes: Math.round((active?.maxCallSeconds ?? 600) / 60),
    extraInstructions: "",
    useAi: false,
  }));

  // Status can arrive after first render — refresh provider defaults on a fresh draft.
  useEffect(() => {
    if (!status || active) return;
    setDraft((d) => ({
      ...d,
      voiceProvider: status.defaults.tts,
      llmProvider: status.defaults.llm,
      llmModel: modelFor(status.defaults.llm),
      sttProvider: status.defaults.stt,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Default voiceId to the provider's first voice once the list loads.
  useEffect(() => {
    const list = voices.data?.[draft.voiceProvider] ?? [];
    if (list.length && !list.some((v) => v.id === draft.voiceId)) {
      setDraft((d) => ({ ...d, voiceId: list[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices.data, draft.voiceProvider]);

  const [preview, setPreview] = useState<PromptPreview | undefined>();
  const [previewing, setPreviewing] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [deployed, setDeployed] = useState<number | undefined>();

  // The compiled prompt depends on these — changing them invalidates a stale preview.
  const factoryInputs = `${draft.personality}|${draft.tools.join(",")}|${draft.extraInstructions}|${draft.useAi}`;
  useEffect(() => {
    setPreview(undefined);
  }, [factoryInputs]);

  const toDraftPayload = (): ReceptionistDraft => ({
    personality: draft.personality,
    voice: { provider: draft.voiceProvider, voiceId: draft.voiceId },
    llm: { provider: draft.llmProvider, model: draft.llmModel.trim(), maxTokens: draft.maxTokens },
    sttProvider: draft.sttProvider,
    tools: draft.tools,
    maxCallSeconds: draft.maxCallMinutes * 60,
    extraInstructions: draft.extraInstructions.trim() || undefined,
    useAi: draft.useAi,
    // Send the compiled text only if the operator previewed (and possibly edited) it.
    systemPrompt: preview?.systemPrompt,
    greeting: preview?.greeting,
  });

  const runPreview = async () => {
    setPreviewing(true);
    setErr(undefined);
    try {
      setPreview(await previewReceptionist(biz.id, toDraftPayload()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  const deploy = async () => {
    setDeploying(true);
    setErr(undefined);
    setDeployed(undefined);
    try {
      const rcp = await deployReceptionist(biz.id, toDraftPayload());
      setDeployed(rcp.version);
      versions.reload();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeploying(false);
    }
  };

  const toggleTool = (tool: string) =>
    setDraft((d) => ({ ...d, tools: d.tools.includes(tool) ? d.tools.filter((t) => t !== tool) : [...d.tools, tool] }));

  const voiceList = voices.data?.[draft.voiceProvider] ?? [];

  return (
    <div>
      <div className="twopane">
        <div>
          <Panel title="Personality">
            <div className="radio-cards" role="radiogroup" aria-label="Personality">
              {PERSONALITIES.map((p) => (
                <label key={p.id} className={`radio-card${draft.personality === p.id ? " on" : ""}`}>
                  <input
                    type="radio"
                    name="personality"
                    checked={draft.personality === p.id}
                    onChange={() => setDraft((d) => ({ ...d, personality: p.id }))}
                  />
                  <div className="t">{p.id}</div>
                  <div className="d">{p.blurb}</div>
                </label>
              ))}
            </div>
          </Panel>

          <Panel title="Voice & brain">
            <div className="formrow c2">
              <Field label="Voice provider">
                <select
                  className="select"
                  value={draft.voiceProvider}
                  onChange={(e) => setDraft((d) => ({ ...d, voiceProvider: e.target.value, voiceId: "" }))}
                >
                  {ttsProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Voice">
                <select className="select" value={draft.voiceId} onChange={(e) => setDraft((d) => ({ ...d, voiceId: e.target.value }))}>
                  {voiceList.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="LLM provider">
                <select
                  className="select"
                  value={draft.llmProvider}
                  onChange={(e) => setDraft((d) => ({ ...d, llmProvider: e.target.value, llmModel: modelFor(e.target.value) }))}
                >
                  {llmProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model" hint="Latency matters on a live call — small and fast wins.">
                <input className="input mono" value={draft.llmModel} onChange={(e) => setDraft((d) => ({ ...d, llmModel: e.target.value }))} />
              </Field>
              <Field label="Speech-to-text">
                <select className="select" value={draft.sttProvider} onChange={(e) => setDraft((d) => ({ ...d, sttProvider: e.target.value }))}>
                  {sttProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Max reply tokens">
                <input
                  className="input"
                  type="number"
                  min={64}
                  max={2048}
                  value={draft.maxTokens}
                  onChange={(e) => setDraft((d) => ({ ...d, maxTokens: Number(e.target.value) || 512 }))}
                />
              </Field>
            </div>
          </Panel>

          <Panel title="What it's allowed to do">
            {ALL_TOOLS.map((tool) => (
              <label key={tool} className="checkrow">
                <input type="checkbox" checked={draft.tools.includes(tool)} onChange={() => toggleTool(tool)} />
                <span>
                  <span className="t">{TOOL_LABELS[tool].label}</span>
                  <span className="d"> — {TOOL_LABELS[tool].hint}</span>
                </span>
              </label>
            ))}
            {draft.tools.includes("transfer_call") && !biz.forwardNumber ? (
              <div className="note warn" style={{ marginTop: 8, marginBottom: 0 }}>
                Transfers are on but the profile has no forward number — add one under Edit profile.
              </div>
            ) : null}
            <div className="formrow c2" style={{ marginTop: 14 }}>
              <Field label="Call length cap (minutes)" hint="The receptionist wraps up politely at the limit.">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={60}
                  value={draft.maxCallMinutes}
                  onChange={(e) => setDraft((d) => ({ ...d, maxCallMinutes: Number(e.target.value) || 10 }))}
                />
              </Field>
            </div>
            <Field label="Extra instructions (optional)" hint="Anything specific: “always mention the summer special”, “never quote exact wait times”.">
              <textarea
                className="textarea"
                value={draft.extraInstructions}
                onChange={(e) => setDraft((d) => ({ ...d, extraInstructions: e.target.value }))}
              />
            </Field>
            {status?.factoryAi ? (
              <label className="checkrow">
                <input type="checkbox" checked={draft.useAi} onChange={(e) => setDraft((d) => ({ ...d, useAi: e.target.checked }))} />
                <span>
                  <span className="t">Refine with Claude</span>
                  <span className="d"> — a one-shot pass by the factory model polishes the compiled prompt for this specific business.</span>
                </span>
              </label>
            ) : null}
          </Panel>

          <CalendarPanel biz={biz} />
        </div>

        <div>
          <Panel
            title="Compiled prompt"
            lamp={preview ? "bell" : "off"}
            actions={
              <button className="btn btn-outline sm" onClick={runPreview} disabled={previewing}>
                {previewing ? "Compiling…" : preview ? "Recompile" : "Preview prompt"}
              </button>
            }
          >
            {preview ? (
              <>
                {preview.aiRefined ? (
                  <div style={{ marginBottom: 10 }}>
                    <Chip tone="bell">Refined by Claude</Chip>
                  </div>
                ) : null}
                <Field label="Greeting" hint="The first thing callers hear. Edit freely.">
                  <input
                    className="input"
                    value={preview.greeting}
                    onChange={(e) => setPreview((p) => (p ? { ...p, greeting: e.target.value } : p))}
                  />
                </Field>
                <Field label="System prompt" hint="Compiled from the profile. Edits here are used as-is when you deploy.">
                  <textarea
                    className="prompt-view"
                    value={preview.systemPrompt}
                    onChange={(e) => setPreview((p) => (p ? { ...p, systemPrompt: e.target.value } : p))}
                    rows={18}
                  />
                </Field>
              </>
            ) : (
              <p style={{ color: "var(--muted)", margin: 0 }}>
                The factory compiles the business profile — hours, services, FAQs, policies — into a voice-tuned system
                prompt. Preview it here before deploying, or deploy directly and it compiles with the settings on the left.
              </p>
            )}
          </Panel>

          {err ? <ErrorNote msg={err} /> : null}
          {deployed !== undefined ? (
            <div className="note" role="status">
              Deployed v{deployed}. It's answering now — try a test call.
            </div>
          ) : null}
          <button className="btn btn-primary" onClick={deploy} disabled={deploying || !draft.voiceId}>
            {deploying ? "Deploying…" : active ? `Deploy v${(versions.data?.[0]?.version ?? active.version) + 1}` : "Deploy receptionist"}
          </button>
          <p style={{ color: "var(--faint)", fontSize: 12, marginTop: 8 }}>
            Deploying creates a new version and puts it live on the line. Earlier versions stay in the log below.
          </p>

          <Panel title="Version log" tight>
            {versions.loading ? <Spinner /> : null}
            {versions.data && versions.data.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Ver</th>
                    <th>Created</th>
                    <th>Personality</th>
                    <th>Model</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.data.map((v) => (
                    <tr key={v.id}>
                      <td style={{ width: 30 }}>
                        <Lamp state={v.active ? "ok" : "off"} title={v.active ? "Active" : "Retired"} />
                      </td>
                      <td className="mono">v{v.version}</td>
                      <td style={{ color: "var(--muted)" }}>{fmtDateTime(v.createdAt)}</td>
                      <td style={{ textTransform: "capitalize" }}>{v.personality}</td>
                      <td className="mono">{v.llm.model}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : !versions.loading ? (
              <p style={{ color: "var(--muted)", padding: 16, margin: 0 }}>No versions yet.</p>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
