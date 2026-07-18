import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createBusiness, deleteBusiness, extractWebsite, getBusiness, updateBusiness } from "../api";
import { useStatus } from "../App";
import { listTimezones } from "../format";
import { DAY_KEYS, DAY_LABELS } from "../types";
import type { BusinessInput, DayKey, Faq, Service, WeekHours } from "../types";
import { ErrorNote, Field, PageHead, Panel, Spinner } from "../ui";

function defaultHours(): WeekHours {
  const open = { open: true, ranges: [{ start: "09:00", end: "17:00" }] };
  const closed = { open: false, ranges: [] as Array<{ start: string; end: string }> };
  return {
    mon: { ...open, ranges: [...open.ranges] },
    tue: { ...open, ranges: [{ ...open.ranges[0] }] },
    wed: { ...open, ranges: [{ ...open.ranges[0] }] },
    thu: { ...open, ranges: [{ ...open.ranges[0] }] },
    fri: { ...open, ranges: [{ ...open.ranges[0] }] },
    sat: { ...closed },
    sun: { ...closed, ranges: [] },
  };
}

function blankBusiness(): BusinessInput {
  return {
    name: "",
    industry: "",
    description: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles",
    address: "",
    website: "",
    email: "",
    forwardNumber: "",
    notifySms: true,
    notifyNumber: "",
    hours: defaultHours(),
    services: [],
    faqs: [],
    policies: "",
    notes: "",
  };
}

function HoursEditor({ hours, onChange }: { hours: WeekHours; onChange: (h: WeekHours) => void }) {
  const setDay = (key: DayKey, patch: Partial<WeekHours[DayKey]>) =>
    onChange({ ...hours, [key]: { ...hours[key], ...patch } });

  const setRange = (key: DayKey, idx: number, field: "start" | "end", value: string) => {
    const ranges = hours[key].ranges.map((r, i) => (i === idx ? { ...r, [field]: value } : r));
    setDay(key, { ranges });
  };

  const applyMondayToWeekdays = () => {
    const mon = hours.mon;
    const next = { ...hours };
    for (const k of ["tue", "wed", "thu", "fri"] as DayKey[]) {
      next[k] = { open: mon.open, ranges: mon.ranges.map((r) => ({ ...r })) };
    }
    onChange(next);
  };

  return (
    <div>
      {DAY_KEYS.map((key) => {
        const day = hours[key];
        return (
          <div className="editrow" key={key}>
            <div className="day">{DAY_LABELS[key].slice(0, 3)}</div>
            <label className="checkrow" style={{ padding: "4px 0", width: 74, flex: "none" }}>
              <input
                type="checkbox"
                checked={day.open}
                onChange={(e) =>
                  setDay(key, {
                    open: e.target.checked,
                    ranges: e.target.checked && day.ranges.length === 0 ? [{ start: "09:00", end: "17:00" }] : day.ranges,
                  })
                }
              />
              <span className="d">{day.open ? "Open" : "Closed"}</span>
            </label>
            <div className="grow">
              {day.open
                ? day.ranges.map((r, i) => (
                    <span className="time-pair" key={i}>
                      <input
                        className="input time"
                        type="time"
                        value={r.start}
                        onChange={(e) => setRange(key, i, "start", e.target.value)}
                        aria-label={`${DAY_LABELS[key]} opens`}
                      />
                      <span className="dash">–</span>
                      <input
                        className="input time"
                        type="time"
                        value={r.end}
                        onChange={(e) => setRange(key, i, "end", e.target.value)}
                        aria-label={`${DAY_LABELS[key]} closes`}
                      />
                      {day.ranges.length > 1 ? (
                        <button
                          type="button"
                          className="btn btn-quiet sm"
                          onClick={() => setDay(key, { ranges: day.ranges.filter((_, j) => j !== i) })}
                          aria-label="Remove range"
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))
                : null}
              {day.open ? (
                <button
                  type="button"
                  className="btn btn-quiet sm"
                  onClick={() => setDay(key, { ranges: [...day.ranges, { start: "13:00", end: "17:00" }] })}
                >
                  + split shift
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      <div style={{ paddingTop: 10 }}>
        <button type="button" className="btn btn-outline sm" onClick={applyMondayToWeekdays}>
          Copy Monday to Tue–Fri
        </button>
      </div>
    </div>
  );
}

function ServicesEditor({ services, onChange }: { services: Service[]; onChange: (s: Service[]) => void }) {
  const set = (i: number, patch: Partial<Service>) =>
    onChange(services.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div>
      {services.map((s, i) => (
        <div className="editrow" key={i}>
          <div className="grow">
            <div className="formrow c3">
              <Field label="Service">
                <input className="input" value={s.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Teeth cleaning" />
              </Field>
              <Field label="Price">
                <input className="input" value={s.price ?? ""} onChange={(e) => set(i, { price: e.target.value })} placeholder="$120 · from $95 · free" />
              </Field>
              <Field label="Duration (min)">
                <input
                  className="input"
                  type="number"
                  min={5}
                  value={s.durationMin ?? ""}
                  onChange={(e) => set(i, { durationMin: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="45"
                />
              </Field>
            </div>
            <Field label="Description (optional)">
              <input className="input" value={s.description ?? ""} onChange={(e) => set(i, { description: e.target.value })} placeholder="What callers should know about it" />
            </Field>
          </div>
          <button type="button" className="btn btn-quiet sm" onClick={() => onChange(services.filter((_, j) => j !== i))} aria-label="Remove service">
            ×
          </button>
        </div>
      ))}
      <div style={{ paddingTop: 10 }}>
        <button type="button" className="btn btn-outline sm" onClick={() => onChange([...services, { name: "" }])}>
          + Add service
        </button>
      </div>
    </div>
  );
}

function FaqsEditor({ faqs, onChange }: { faqs: Faq[]; onChange: (f: Faq[]) => void }) {
  const set = (i: number, patch: Partial<Faq>) => onChange(faqs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div>
      {faqs.map((f, i) => (
        <div className="editrow" key={i}>
          <div className="grow">
            <Field label="Question">
              <input className="input" value={f.question} onChange={(e) => set(i, { question: e.target.value })} placeholder="Do you take insurance?" />
            </Field>
            <Field label="Answer">
              <textarea className="textarea" rows={2} value={f.answer} onChange={(e) => set(i, { answer: e.target.value })} placeholder="The answer the receptionist should give" />
            </Field>
          </div>
          <button type="button" className="btn btn-quiet sm" onClick={() => onChange(faqs.filter((_, j) => j !== i))} aria-label="Remove FAQ">
            ×
          </button>
        </div>
      ))}
      <div style={{ paddingTop: 10 }}>
        <button type="button" className="btn btn-outline sm" onClick={() => onChange([...faqs, { question: "", answer: "" }])}>
          + Add FAQ
        </button>
      </div>
    </div>
  );
}

export default function BusinessForm() {
  const { id } = useParams<{ id: string }>();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const status = useStatus();

  const [form, setForm] = useState<BusinessInput>(blankBusiness);
  const [loading, setLoading] = useState(editing);
  const [loadErr, setLoadErr] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | undefined>();

  const [extractUrl, setExtractUrl] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractMsg, setExtractMsg] = useState<string | undefined>();
  const [extractErr, setExtractErr] = useState<string | undefined>();

  const timezones = useMemo(listTimezones, []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    getBusiness(id)
      .then((b) => {
        if (!alive) return;
        setForm({
          name: b.name,
          industry: b.industry,
          description: b.description,
          timezone: b.timezone,
          address: b.address ?? "",
          website: b.website ?? "",
          email: b.email ?? "",
          forwardNumber: b.forwardNumber ?? "",
          notifySms: b.notifySms ?? true,
          notifyNumber: b.notifyNumber ?? "",
          hours: b.hours,
          services: b.services,
          faqs: b.faqs,
          policies: b.policies,
          notes: b.notes,
        });
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoadErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const patch = (p: Partial<BusinessInput>) => setForm((f) => ({ ...f, ...p }));

  const runExtract = async () => {
    if (!extractUrl.trim()) return;
    setExtracting(true);
    setExtractErr(undefined);
    setExtractMsg(undefined);
    try {
      const { extracted } = await extractWebsite(extractUrl.trim());
      const filled: string[] = [];
      const p: Partial<BusinessInput> = {};
      if (extracted.name) (p.name = extracted.name), filled.push("name");
      if (extracted.industry) (p.industry = extracted.industry), filled.push("industry");
      if (extracted.description) (p.description = extracted.description), filled.push("description");
      if (extracted.address) (p.address = extracted.address), filled.push("address");
      if (extracted.email) (p.email = extracted.email), filled.push("email");
      if (extracted.services?.length) (p.services = extracted.services), filled.push(`${extracted.services.length} services`);
      if (extracted.faqs?.length) (p.faqs = extracted.faqs), filled.push(`${extracted.faqs.length} FAQs`);
      if (extracted.policies) (p.policies = extracted.policies), filled.push("policies");
      p.website = extractUrl.trim();
      patch(p);
      setExtractMsg(filled.length ? `Filled in: ${filled.join(", ")}. Review before saving — hours still need to be set by hand.` : "Nothing usable found on that page.");
    } catch (e) {
      setExtractErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExtracting(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) {
      setSaveErr("Business name is required.");
      return;
    }
    setSaving(true);
    setSaveErr(undefined);
    const cleaned: BusinessInput = {
      ...form,
      services: form.services.filter((s) => s.name.trim()),
      faqs: form.faqs.filter((f) => f.question.trim() && f.answer.trim()),
    };
    try {
      if (editing && id) {
        await updateBusiness(id, cleaned);
        navigate(`/b/${id}`);
      } else {
        const biz = await createBusiness(cleaned);
        navigate(`/b/${biz.id}/receptionist`);
      }
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id) return;
    if (!window.confirm(`Delete ${form.name || "this business"} and its receptionist? This can't be undone.`)) return;
    try {
      await deleteBusiness(id);
      navigate("/");
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <Spinner label="Loading profile…" />;
  if (loadErr) return <ErrorNote msg={loadErr} />;

  return (
    <div className="page">
      <PageHead
        sec={editing ? "SEC 02.1" : "SEC 02"}
        eyebrow={editing ? "Line record — edit" : "New line record"}
        title={editing ? `Edit ${form.name || "business"}` : "New business"}
        sub="Everything here feeds the receptionist's knowledge. The more complete the profile, the better it answers."
        actions={
          <Link to={editing && id ? `/b/${id}` : "/"} className="btn btn-quiet">
            Cancel
          </Link>
        }
      />

      {!editing && status?.factoryAi ? (
        <Panel title="Start from their website" lamp="bell">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="input"
              style={{ flex: "1 1 280px" }}
              placeholder="sunrisedental.com"
              value={extractUrl}
              onChange={(e) => setExtractUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runExtract()}
            />
            <button className="btn btn-primary" onClick={runExtract} disabled={extracting || !extractUrl.trim()}>
              {extracting ? "Reading site…" : "Extract with AI"}
            </button>
          </div>
          <p className="hint" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--faint)" }}>
            Claude reads the site and fills the form below. It only keeps facts it actually finds.
          </p>
          {extractMsg ? <div className="note" style={{ marginTop: 10, marginBottom: 0 }}>{extractMsg}</div> : null}
          {extractErr ? <ErrorNote msg={extractErr} /> : null}
        </Panel>
      ) : null}

      <Panel title="Identity">
        <div className="formrow c2">
          <Field label="Business name" hint="Required — used in the greeting.">
            <input className="input" value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Sunrise Dental Studio" />
          </Field>
          <Field label="Industry" hint="Plain words: “dental clinic”, “plumber”, “hair salon”.">
            <input className="input" value={form.industry} onChange={(e) => patch({ industry: e.target.value })} placeholder="dental clinic" />
          </Field>
        </div>
        <Field label="Description" hint="One or two sentences a receptionist would use to describe the business.">
          <textarea className="textarea" value={form.description} onChange={(e) => patch({ description: e.target.value })} />
        </Field>
        <Field label="Timezone" hint="Open/closed answers are computed in this timezone.">
          <input className="input" list="tz-list" value={form.timezone} onChange={(e) => patch({ timezone: e.target.value })} />
        </Field>
        <datalist id="tz-list">
          {timezones.map((tz) => (
            <option value={tz} key={tz} />
          ))}
        </datalist>
      </Panel>

      <Panel title="Contact & location">
        <div className="formrow c2">
          <Field label="Address">
            <input className="input" value={form.address ?? ""} onChange={(e) => patch({ address: e.target.value })} placeholder="482 Orange Grove Blvd, Pasadena, CA" />
          </Field>
          <Field label="Website">
            <input className="input" value={form.website ?? ""} onChange={(e) => patch({ website: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="Email">
            <input className="input" value={form.email ?? ""} onChange={(e) => patch({ email: e.target.value })} placeholder="hello@…" />
          </Field>
          <Field label="Forward number" hint="Where “transfer to a human” sends the call. E.164 format.">
            <input className="input mono" value={form.forwardNumber ?? ""} onChange={(e) => patch({ forwardNumber: e.target.value })} placeholder="+16265550123" />
          </Field>
        </div>
      </Panel>

      <Panel title="Client notifications">
        <label className="checkrow">
          <input type="checkbox" checked={form.notifySms ?? true} onChange={(e) => patch({ notifySms: e.target.checked })} />
          <span>
            <span className="t">Text me new messages &amp; appointments</span>
            <span className="d"> — the moment the receptionist captures a message or appointment on a real call, it’s texted over so nothing waits in the dashboard.</span>
          </span>
        </label>
        {form.notifySms ? (
          <div className="formrow" style={{ marginTop: 12 }}>
            <Field label="Notify this number" hint="Leave blank to use the forward number. Handy when a different person handles the front desk.">
              <input
                className="input mono"
                value={form.notifyNumber ?? ""}
                onChange={(e) => patch({ notifyNumber: e.target.value })}
                placeholder={form.forwardNumber || "+16265550123"}
              />
            </Field>
          </div>
        ) : null}
      </Panel>

      <Panel title="Opening hours">
        <HoursEditor hours={form.hours} onChange={(hours) => patch({ hours })} />
      </Panel>

      <Panel title="Services & prices">
        {form.services.length === 0 ? (
          <p style={{ color: "var(--muted)", margin: "0 0 4px" }}>
            Callers ask about prices constantly — list the common services so the receptionist can quote them.
          </p>
        ) : null}
        <ServicesEditor services={form.services} onChange={(services) => patch({ services })} />
      </Panel>

      <Panel title="FAQs">
        {form.faqs.length === 0 ? (
          <p style={{ color: "var(--muted)", margin: "0 0 4px" }}>
            Insurance, parking, kids, walk-ins — write the answer once and every caller gets it right.
          </p>
        ) : null}
        <FaqsEditor faqs={form.faqs} onChange={(faqs) => patch({ faqs })} />
      </Panel>

      <Panel title="Policies & notes">
        <Field label="Policies" hint="Cancellations, payment methods, arrival instructions…">
          <textarea className="textarea" value={form.policies} onChange={(e) => patch({ policies: e.target.value })} />
        </Field>
        <Field label="Notes for the receptionist" hint="Staff names, things to emphasize, anything else it should know.">
          <textarea className="textarea" value={form.notes} onChange={(e) => patch({ notes: e.target.value })} />
        </Field>
      </Panel>

      {saveErr ? <ErrorNote msg={saveErr} /> : null}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : editing ? "Save changes" : "Create business"}
        </button>
        {!editing ? <span style={{ color: "var(--faint)", fontSize: 12.5 }}>Next step: set up its receptionist.</span> : null}
        <span style={{ flex: 1 }} />
        {editing ? (
          <button className="btn btn-danger" onClick={remove}>
            Delete business
          </button>
        ) : null}
      </div>
    </div>
  );
}
