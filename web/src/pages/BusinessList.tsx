import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listBusinesses, seedDemo, useLoad } from "../api";
import { fmtPhone } from "../format";
import type { BusinessSummary } from "../types";
import { Chip, Empty, ErrorNote, Lamp, PageHead, Panel, Spinner, StatusLine } from "../ui";
import type { LampState } from "../ui";

function lineStatus(b: BusinessSummary): { state: LampState; text: string } {
  if (b.receptionist && b.number) return { state: "ok", text: "In service" };
  if (b.receptionist) return { state: "amber", text: "No number — test calls only" };
  return { state: "off", text: "Draft — no receptionist yet" };
}

/** First-run setup guide shown under the empty state until the first business exists. */
function Onboarding() {
  const steps: Array<{
    n: string;
    lamp: LampState;
    pulse?: boolean;
    status: string;
    title: string;
    body: ReactNode;
    action?: ReactNode;
  }> = [
    {
      n: "01",
      lamp: "bell",
      pulse: true,
      status: "Up next",
      title: "Create a business",
      body: "Enter the profile — hours, services, FAQs, policies — or paste the business's website URL and let the factory fill the form in.",
      action: (
        <Link to="/new" className="btn btn-outline sm">
          Start →
        </Link>
      ),
    },
    {
      n: "02",
      lamp: "off",
      status: "Waiting on 01",
      title: "Configure the receptionist",
      body: "On the business's Receptionist tab, pick a personality, voice, and call model, preview the compiled prompt, and deploy version 1. Try it in the Test call tab — no phone needed.",
    },
    {
      n: "03",
      lamp: "off",
      status: "Waiting on 02",
      title: "Put it on a number",
      body: "On Overview → Phone line, search and buy a number or attach one you own — the Twilio voice webhook is configured automatically. Real callers reach your receptionist from then on.",
    },
  ];
  return (
    <Panel
      title="First-time setup"
      lamp="bell"
      actions={<span className="onboard-progress">Step 1 of 3 · 0 complete</span>}
      tight
    >
      <ol className="onboard-steps">
        {steps.map((s) => (
          <li className="onboard-step" key={s.n}>
            <span className="onboard-n">
              <Lamp state={s.lamp} pulse={s.pulse} />
              {s.n}
            </span>
            <div className="onboard-body">
              <div className="onboard-t">
                {s.title}
                <span className="onboard-status">{s.status}</span>
              </div>
              <p>{s.body}</p>
            </div>
            {s.action ? <span className="onboard-action">{s.action}</span> : null}
          </li>
        ))}
      </ol>
      <div className="onboard-learn">
        <span className="onboard-learn-title">Learn more</span>
        <Link to="/costs">Rate card — estimate provider cost per business</Link>
        <Link to="/billing">Plans &amp; trial status</Link>
        <a href="https://github.com/ebeetles/CallCatcher#readme" target="_blank" rel="noreferrer">
          README — how CallCatcher works
        </a>
        <a
          href="https://github.com/ebeetles/CallCatcher/blob/main/SAAS_SETUP.md"
          target="_blank"
          rel="noreferrer"
        >
          Setup guide (self-hosting)
        </a>
      </div>
    </Panel>
  );
}

function Card({ b }: { b: BusinessSummary }) {
  const st = lineStatus(b);
  const r = b.receptionist;
  return (
    <Link to={`/b/${b.id}`} className="bizcard">
      <StatusLine state={st.state}>{st.text}</StatusLine>
      <div>
        <div className="name">{b.name}</div>
        <div className="meta">{b.industry || "—"}</div>
      </div>
      {b.number ? (
        <div className="num">{fmtPhone(b.number.e164)}</div>
      ) : (
        <div className="num none">No number attached</div>
      )}
      <hr />
      <div className="stats">
        {b.stats.today} today · {b.stats.total} calls · {b.stats.totalMinutes} min
      </div>
      {r ? (
        <div className="meta">
          <Chip tone="bell">v{r.version}</Chip>
          <Chip>{r.personality}</Chip>
          <Chip mono title="Call model">
            {r.llm.model}
          </Chip>
        </div>
      ) : null}
    </Link>
  );
}

export default function BusinessList() {
  const { data, error, loading, reload } = useLoad(listBusinesses, []);
  const navigate = useNavigate();
  const [seeding, setSeeding] = useState(false);
  const [seedErr, setSeedErr] = useState<string | undefined>();

  const seed = async () => {
    setSeeding(true);
    setSeedErr(undefined);
    try {
      const biz = await seedDemo();
      navigate(`/b/${biz.id}`);
    } catch (e) {
      setSeedErr(e instanceof Error ? e.message : String(e));
      setSeeding(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        sec="SEC 01"
        eyebrow="Lines in service"
        title="Businesses"
        sub="Every business gets its own receptionist: a profile, a compiled prompt, a voice, and a phone number."
        actions={
          <Link to="/new" className="btn btn-primary">
            + New business
          </Link>
        }
      />
      {loading ? <Spinner label="Loading businesses…" /> : null}
      {error ? <ErrorNote msg={error} onRetry={reload} /> : null}
      {seedErr ? <ErrorNote msg={seedErr} /> : null}
      {data && data.length === 0 ? (
        <>
          <Empty
            title="No lines in service"
            body="Create your first business to put a receptionist on the phone — or seed the demo dental clinic to see a finished one."
          >
            <Link to="/new" className="btn btn-primary">
              Create a business
            </Link>
            <button className="btn btn-outline" onClick={seed} disabled={seeding}>
              {seeding ? "Seeding…" : "Seed demo clinic"}
            </button>
          </Empty>
          <Onboarding />
        </>
      ) : null}
      {data && data.length > 0 ? (
        <div className="grid-cards">
          {data.map((b) => (
            <Card key={b.id} b={b} />
          ))}
        </div>
      ) : null}
      <div className="footer-meta">
        <Lamp state="off" /> CallCatcher BSP C46.121 · issue 1
      </div>
    </div>
  );
}
