// Create or edit a Salesforce record with a describe-driven Lightning form.
// Without an id it creates (createable fields, required ones marked); with
// an id it loads the record and saves only the fields that changed. Saving
// goes through Record.Create / Record.Update, which the host confirms. The
// draft is readable via component state; `saved` {sobject, id} fires after.
import { Button, Skeleton, Switch } from "antd";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../shared/salesforce.css";
import "../../shared/tangram-buttons.css";
import { Describe, Field, SfRecord, commonFieldNames, describe, errorText, iconFor, nameField } from "../../shared/sf-describe";
import FieldInput, { isLongText } from "./field-input";

const tangram = (window as any).tangram;

type Values = Record<string, unknown>;
type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved"; created: boolean }
  | { kind: "error"; message: string; fatal?: boolean };

const blank = (v: unknown) => v === null || v === undefined || v === "";

function writable(f: Field, creating: boolean): boolean {
  if (f.calculated || f.autoNumber || f.compoundFieldName || ["id", "base64", "location", "address"].includes(f.type)) return false;
  return creating ? !!f.createable : !!f.updateable;
}

// Salesforce enforces these on save; checkboxes always have a value.
function required(f: Field): boolean {
  return !f.nillable && !f.defaultedOnCreate && f.type !== "boolean";
}

// The body to send: every non-empty value on create; on edit only changed fields, a cleared one as null.
function changes(fields: Field[], values: Values, original: Values, creating: boolean): Values {
  const out: Values = {};
  for (const f of fields) {
    const v = values[f.name];
    if (creating) {
      if (!blank(v)) out[f.name] = v;
    } else if ((blank(v) ? null : v) !== (blank(original[f.name]) ? null : original[f.name])) {
      out[f.name] = blank(v) ? null : v;
    }
  }
  return out;
}

export default function RecordEditor() {
  const [sobject, setSobject] = useState("");
  const [id, setId] = useState("");
  const [desc, setDesc] = useState<Describe | null>(null);
  const [original, setOriginal] = useState<Values>({});
  const [values, setValues] = useState<Values>({});
  const [prefilled, setPrefilled] = useState<string[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const seq = useRef(0);
  const draft = useRef<Record<string, unknown>>({});

  const load = useCallback((obj: string, recId: string, prefill: Values) => {
    const mine = ++seq.current;
    setSobject(obj);
    setId(recId);
    setDesc(null);
    setShowAll(false);
    if (!obj) {
      setStatus({ kind: "error", message: "Pass an sobject (e.g. Lead) — and an id to edit an existing record.", fatal: true });
      return;
    }
    setStatus({ kind: "loading" });
    Promise.all([
      describe(obj),
      recId
        ? (tangram.performAction({ resourceType: "Record", action: "Get" }, { parameters: { sobject: obj, id: recId } }) as Promise<SfRecord>)
        : Promise.resolve({} as SfRecord),
    ])
      .then(([d, rec]) => {
        if (mine !== seq.current) return;
        const creating = !recId;
        const editable = new Map(d.fields.filter((f) => writable(f, creating)).map((f) => [f.name, f]));
        const base: Values = {};
        if (!creating) for (const name of editable.keys()) base[name] = rec?.[name] ?? null;
        const pre = Object.keys(prefill).filter((k) => editable.has(k));
        setIgnored(Object.keys(prefill).filter((k) => !editable.has(k)));
        setPrefilled(pre);
        setDesc(d);
        setOriginal(base);
        setValues({ ...base, ...Object.fromEntries(pre.map((k) => [k, prefill[k]])) });
        setStatus({ kind: "ready" });
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setStatus({ kind: "error", message: errorText(e), fatal: true });
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const fields = inputs?.fields && typeof inputs.fields === "object" && !Array.isArray(inputs.fields) ? (inputs.fields as Values) : {};
      load(String(inputs?.sobject ?? "").trim(), String(inputs?.id ?? "").trim(), fields);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
    tangram.provideState?.(() => ({ ...draft.current }));
  }, [load]);

  const creating = !id;
  const editable = useMemo(() => (desc ? desc.fields.filter((f) => writable(f, creating)) : []), [desc, creating]);
  const nf = desc ? nameField(desc) : undefined;
  const missing = editable.filter((f) => required(f) && blank(values[f.name]) && (creating || !blank(original[f.name]) || f === nf));
  const body = changes(editable, values, original, creating);

  draft.current = { sobject, id: id || null, mode: creating ? "create" : "edit", changes: body, missingRequired: missing.map((f) => f.name) };

  const common = commonFieldNames();
  const visible = showAll
    ? editable
    : editable.filter((f) => required(f) || f === nf || prefilled.includes(f.name) || common.has(f.name) || f.name in body);
  // name field first, then required, then describe order
  const ordered = [...visible].sort((a, b) => Number(b === nf) - Number(a === nf) || Number(required(b)) - Number(required(a)));

  const busy = status.kind === "saving" || status.kind === "loading";
  const dirty = Object.keys(body).length > 0;

  function save() {
    if (!dirty || missing.length || busy) return;
    const mine = seq.current;
    const sent = { ...body };
    setStatus({ kind: "saving" });
    const call = creating
      ? tangram.performAction({ resourceType: "Record", action: "Create" }, { parameters: { sobject }, requestBody: sent })
      : tangram.performAction({ resourceType: "Record", action: "Update" }, { parameters: { sobject, id }, requestBody: sent });
    call
      .then((r: { id?: string; success?: boolean; errors?: unknown[] } | null) => {
        if (mine !== seq.current) return;
        if (creating && r && r.success === false) throw new Error(JSON.stringify(r.errors ?? "Create failed"));
        const savedId = creating ? String(r?.id ?? "") : id;
        if (creating && !savedId) throw new Error("Salesforce returned no record id");
        // the saved values become the baseline: further saves update this record
        const next = { ...original, ...values };
        setOriginal(next);
        setValues(next);
        setPrefilled([]);
        setId(savedId);
        setStatus({ kind: "saved", created: creating });
        tangram.emit("saved", { sobject, id: savedId });
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setStatus({ kind: "error", message: errorText(e) });
      });
  }

  const icon = iconFor(sobject || "Record");
  const head = (
    <div className="sf-head">
      <span className="sf-icon" style={{ background: icon.color }} aria-hidden="true">
        {icon.text}
      </span>
      <div className="meta">
        <div className="sf-eyebrow">{desc?.label ?? sobject ?? "Record"}</div>
        <h1 className="sf-title">
          {creating ? `New ${desc?.label ?? sobject}` : `Edit ${nf && !blank(original[nf.name]) ? String(original[nf.name]) : id}`}
        </h1>
      </div>
    </div>
  );

  if (status.kind === "loading" || (status.kind === "error" && status.fatal) || !desc)
    return (
      <div className="sf-root">
        <div className="sf-card">
          {head}
          {status.kind === "error" ? (
            <div className="sf-error" role="alert">
              <b>Couldn't open the form</b>
              {status.message}
            </div>
          ) : (
            <div className="sf-pad">
              <Skeleton active title={false} paragraph={{ rows: 6 }} />
            </div>
          )}
        </div>
      </div>
    );

  return (
    <div className="sf-root">
      <div className="sf-card sf-grid-wrap">
        {head}
        {status.kind === "saved" ? (
          <div className="sf-ok" role="status">
            {status.created ? `${desc.label} created` : "Changes saved"} — <span className="sf-mono">{id}</span>
          </div>
        ) : null}
        {status.kind === "error" ? (
          <div className="sf-error" role="alert">
            <b>Couldn't save</b>
            {status.message}
          </div>
        ) : null}
        {ignored.length ? (
          <div className="sf-pad sf-eyebrow">Not editable here, ignored: {ignored.join(", ")}</div>
        ) : null}
        <div className="sf-section">
          <span>{creating ? "Information" : "Fields"}</span>
          <span className="sp" />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400, fontSize: 12 }}>
            <Switch size="small" checked={showAll} onChange={setShowAll} aria-label="Show all fields" />
            Show all fields ({editable.length})
          </label>
        </div>
        <form
          className="sf-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {ordered.map((f) => {
            const req = required(f) && (creating || f === nf || !blank(original[f.name]));
            const err = req && missing.includes(f) && f.name in values;
            return (
              <div key={f.name} className={isLongText(f) ? "full" : undefined}>
                <label className="k" htmlFor={`sf-f-${f.name}`}>
                  {req ? (
                    <abbr className="sf-req" title="required">
                      *
                    </abbr>
                  ) : null}
                  {f.label}
                </label>
                <FieldInput f={f} value={values[f.name]} disabled={busy} onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))} />
                {err ? <div className="err">Complete this field.</div> : f.inlineHelpText ? <div className="help">{f.inlineHelpText}</div> : null}
              </div>
            );
          })}
        </form>
        <div className="sf-footer">
          <span className="note">
            {missing.length
              ? `Required: ${missing.map((f) => f.label).join(", ")}`
              : dirty
                ? `${Object.keys(body).length} field${Object.keys(body).length === 1 ? "" : "s"} to save`
                : "No changes"}
          </span>
          <span className="sp" />
          <Button disabled={busy || !dirty} onClick={() => setValues({ ...original })}>
            {creating ? "Clear" : "Discard changes"}
          </Button>
          <Button type="primary" loading={status.kind === "saving"} disabled={busy || !dirty || missing.length > 0} onClick={save}>
            {creating ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
