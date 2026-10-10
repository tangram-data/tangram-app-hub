// A Salesforce record page in Lightning style: object badge + name, a
// highlights row of up to four key fields, then a two-column details grid
// driven by the object's describe (labels, types, picklist labels). Reference
// fields open the related record by emitting `open` {sobject, id}. Read-only:
// Record.Describe + Record.Get through the connector.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Skeleton, Switch, Tooltip } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/salesforce.css";
import "../../shared/tangram-buttons.css";
import {
  Describe,
  Field,
  SfRecord,
  describe,
  display,
  errorText,
  highlightFields,
  iconFor,
  isEmpty,
  isSystem,
  nameField,
} from "../../shared/sf-describe";

const tangram = (window as any).tangram;

type Loaded = { d: Describe; rec: SfRecord };

function Value({ f, rec }: { f: Field; rec: SfRecord }) {
  const shown = display(f, rec[f.name], rec);
  switch (shown.kind) {
    case "check":
      return <span className={`sf-check ${shown.on ? "on" : "off"}`}>{shown.on ? "✓ Yes" : "No"}</span>;
    case "link":
      return (
        <a href={shown.href} target="_blank" rel="noopener noreferrer">
          {shown.text}
        </a>
      );
    case "ref":
      return (
        <Tooltip title={`Open ${shown.sobject} ${shown.id}`}>
          <button type="button" className="sf-linkbtn sf-mono" onClick={() => tangram.emit("open", { sobject: shown.sobject, id: shown.id })}>
            {shown.text}
          </button>
        </Tooltip>
      );
    default:
      return shown.text ? <span className={shown.mono ? "sf-mono" : undefined}>{shown.text}</span> : null;
  }
}

export default function RecordViewer() {
  const [target, setTarget] = useState<{ sobject: string; id: string }>({ sobject: "", id: "" });
  const [data, setData] = useState<Loaded | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const seq = useRef(0);
  const current = useRef({ sobject: "", id: "" });

  const load = useCallback((sobject: string, id: string) => {
    const mine = ++seq.current;
    // a different record never shows the previous one while loading
    if (sobject !== current.current.sobject || id !== current.current.id) setData(null);
    current.current = { sobject, id };
    setTarget({ sobject, id });
    if (!sobject || !id) {
      setData(null);
      setError("Pass an sobject (e.g. Account) and a record id.");
      setState("error");
      return;
    }
    setState("loading");
    setError("");
    Promise.all([
      describe(sobject),
      tangram.performAction({ resourceType: "Record", action: "Get" }, { parameters: { sobject, id } }) as Promise<SfRecord>,
    ])
      .then(([d, rec]) => {
        if (mine !== seq.current) return;
        setData({ d, rec: rec ?? {} });
        setState("ready");
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setData(null);
        setError(errorText(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => load(String(inputs?.sobject ?? "").trim(), String(inputs?.id ?? "").trim());
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [load]);

  const icon = iconFor(target.sobject || "Record");
  const head = (title: React.ReactNode, eyebrow: string, extra?: React.ReactNode) => (
    <div className="sf-head">
      <span className="sf-icon" style={{ background: icon.color }} aria-hidden="true">
        {icon.text}
      </span>
      <div className="meta">
        <div className="sf-eyebrow">{eyebrow}</div>
        <h1 className="sf-title">{title}</h1>
      </div>
      <div className="acts">
        {extra}
        <Tooltip title="Refresh">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            aria-label="Refresh"
            disabled={state === "loading" || !target.sobject || !target.id}
            onClick={() => load(target.sobject, target.id)}
          />
        </Tooltip>
      </div>
    </div>
  );

  if (state === "loading" && !data)
    return (
      <div className="sf-root">
        <div className="sf-card">
          {head(target.id || "Loading…", target.sobject || "Record")}
          <div className="sf-pad">
            <Skeleton active title={false} paragraph={{ rows: 6 }} />
          </div>
        </div>
      </div>
    );

  if (state === "error" || !data)
    return (
      <div className="sf-root">
        <div className="sf-card">
          {head(target.id || "Record", target.sobject || "Salesforce")}
          <div className="sf-error" role="alert">
            <b>Couldn't load this record</b>
            {error}
          </div>
        </div>
      </div>
    );

  const { d, rec } = data;
  const nf = nameField(d);
  const title = (nf && !isEmpty(rec[nf.name]) ? String(rec[nf.name]) : "") || String(rec.Id ?? target.id);
  const highlights = highlightFields(d, rec);
  const details = d.fields.filter((f) => !isSystem(f) && f !== nf && (showEmpty || !isEmpty(rec[f.name])));

  return (
    <div className="sf-root">
      <div className="sf-card">
        {head(title, d.label || target.sobject)}
        {highlights.length ? (
          <div className="sf-highlights">
            {highlights.map((f) => (
              <div className="sf-hl" key={f.name}>
                <div className="k" title={f.label}>
                  {f.label}
                </div>
                <div className="v">
                  <Value f={f} rec={rec} />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="sf-card sf-grid-wrap">
        <div className="sf-section">
          <span>Details</span>
          <span className="sp" />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: 12 }}>
            <Switch size="small" checked={showEmpty} onChange={setShowEmpty} aria-label="Show empty fields" />
            Show empty
          </label>
        </div>
        {details.length === 0 ? (
          <div className="sf-empty">No other fields have values</div>
        ) : (
          <div className="sf-grid">
            {details.map((f) => (
              <div className="sf-field" key={f.name}>
                <div className="k" title={f.inlineHelpText ?? f.name}>
                  {f.label}
                </div>
                <div className={`v${isEmpty(rec[f.name]) ? " empty" : ""}`}>
                  {isEmpty(rec[f.name]) ? "—" : <Value f={f} rec={rec} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
