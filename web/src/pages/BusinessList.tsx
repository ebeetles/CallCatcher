import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listBusinesses, seedDemo, useLoad } from "../api";
import { fmtPhone } from "../format";
import type { BusinessSummary } from "../types";
import { Chip, Empty, ErrorNote, Lamp, PageHead, Spinner, StatusLine } from "../ui";
import type { LampState } from "../ui";

function lineStatus(b: BusinessSummary): { state: LampState; text: string } {
  if (b.receptionist && b.number) return { state: "ok", text: "In service" };
  if (b.receptionist) return { state: "amber", text: "No number — test calls only" };
  return { state: "off", text: "Draft — no receptionist yet" };
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
