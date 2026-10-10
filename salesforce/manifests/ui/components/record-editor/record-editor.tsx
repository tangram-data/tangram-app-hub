// Create or edit a Salesforce record with a describe-driven Lightning form.
// Without an id it creates (createable fields, required ones marked); with
// an id it loads the record and saves only the fields that changed. Saving
// goes through Record.Create / Record.Update, which the host confirms. The
// draft is readable via component state; `saved` {sobject, id} fires after.
// A save whose outcome is unknown (lost response, 5xx) never re-enables a
// plain retry: an edit is re-read to see whether it landed, a create asks the
// user to check Salesforce and retry explicitly. New inputs wait for a save.
import { Button, Skeleton, Switch } from "antd";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../../shared/salesforce.css";
import "../../shared/tangram-buttons.css";
import { Describe, Field, SfRecord, commonFieldNames, describe, errorText, iconFor, nameField } from "../../shared/sf-describe";
import FieldInput, { isLongText } from "./field-input";
import { classify, notLanded } from "./save-outcome";

const tangram = (window as any).tangram;

type Values = Record<string, unknown>;
type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved"; created: boolean; note?: string }
  | { kind: "error"; message: string; fatal?: boolean }
  // the write may or may not have happened; a create needs an explicit retry
  | { kind: "unknown"; message: string; created: boolean };

const blank = (v: unknown) => v === null || v === undefined || v === "";

// Compound parents (address/location; Contact Name is never createable) are read-only here; their constituents
// (Street, FirstName, LastName…) are ordinary writable fields.
function writable(f: Field, creating: boolean): boolean {
  if (f.calculated || f.autoNumber || ["id", "base64", "location", "address"].includes(f.type)) return false;
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
  const [recordName, setRecordName] = useState("");
  const seq = useRef(0);
  const draft = useRef<Record<string, unknown>>({});
  // inputs that arrive mid-save wait here, so the save's result is never dropped
  const saving = useRef(false);
  const queued = useRef<Record<string, unknown> | null>(null);

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
        // checkboxes always save a value: start them at the field default so what's shown is what's created
        else for (const f of editable.values()) if (f.type === "boolean") base[f.name] = f.defaultValue === true;
        const pre = Object.keys(prefill).filter((k) => editable.has(k));
        setIgnored(Object.keys(prefill).filter((k) => !editable.has(k)));
        setPrefilled(pre);
        const nf0 = nameField(d);
        setRecordName(nf0 && !blank(rec?.[nf0.name]) ? String(rec[nf0.name]) : "");
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

  const apply = useCallback(
    (inputs: Record<string, unknown>) => {
      if (saving.current) {
        queued.current = inputs;
        return;
      }
      const fields = inputs?.fields && typeof inputs.fields === "object" && !Array.isArray(inputs.fields) ? (inputs.fields as Values) : {};
      load(String(inputs?.sobject ?? "").trim(), String(inputs?.id ?? "").trim(), fields);
    },
    [load],
  );

  useEffect(() => {
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
    tangram.provideState?.(() => ({ ...draft.current }));
  }, [apply]);

  // a save settled: inputs that arrived meanwhile apply now
  function settle() {
    saving.current = false;
    const next = queued.current;
    queued.current = null;
    if (next) apply(next);
  }

  const creating = !id;
  const editable = useMemo(() => (desc ? desc.fields.filter((f) => writable(f, creating)) : []), [desc, creating]);
  const nf = desc ? nameField(desc) : undefined;
  const missing = editable.filter((f) => required(f) && blank(values[f.name]) && (creating || !blank(original[f.name]) || f === nf));
  const body = changes(editable, values, original, creating);

  draft.current = { sobject, id: id || null, mode: creating ? "create" : "edit", changes: body, missingRequired: missing.map((f) => f.name) };

  const touched = (n: string) => (blank(values[n]) ? null : values[n]) !== (blank(original[n]) ? null : original[n]);
  const common = commonFieldNames();
  const visible = showAll
    ? editable
    : editable.filter((f) => required(f) || f === nf || prefilled.includes(f.name) || common.has(f.name) || touched(f.name));
  // name field first, then required, then describe order
  const ordered = [...visible].sort((a, b) => Number(b === nf) - Number(a === nf) || Number(required(b)) - Number(required(a)));

  const busy = status.kind === "saving" || status.kind === "loading";
  // checkbox defaults ride along in a create body but aren't changes on their own
  const changed = Object.keys(body).filter(touched);
  const dirty = changed.length > 0;

  function save(force = false) {
    if (!dirty || missing.length || busy || saving.current) return;
    if (status.kind === "unknown" && !force) return;
    const sent = { ...body };
    const target = { sobject, id, creating };
    const fields = editable;
    saving.current = true;
    setStatus({ kind: "saving" });
    const call: Promise<{ id?: string; success?: boolean; errors?: unknown[] } | null> = creating
      ? tangram.performAction({ resourceType: "Record", action: "Create" }, { parameters: { sobject }, requestBody: sent })
      : tangram.performAction({ resourceType: "Record", action: "Update" }, { parameters: { sobject, id }, requestBody: sent });

    // the record as Salesforce now has it becomes the edit baseline (server-populated fields included)
    const landed = (savedId: string, rec: SfRecord | null, refreshError?: string) => {
      const base: Values = {};
      if (rec && desc) for (const f of desc.fields) if (writable(f, false)) base[f.name] = rec[f.name] ?? null;
      const next = rec ? base : { ...original, ...values };
      if (rec && nf && !blank(rec[nf.name])) setRecordName(String(rec[nf.name]));
      setOriginal(next);
      setValues(next);
      setPrefilled([]);
      setId(savedId);
      setStatus({ kind: "saved", created: target.creating, note: refreshError });
      tangram.emit("saved", { sobject: target.sobject, id: savedId });
    };
    const reread = (recId: string) =>
      tangram.performAction({ resourceType: "Record", action: "Get" }, { parameters: { sobject: target.sobject, id: recId } }) as Promise<SfRecord>;

    // write outcome and refresh outcome are handled separately: a failed re-read never turns a save into an error
    call
      .then(
        (r) => {
          if (target.creating && r && r.success === false)
            return setStatus({ kind: "error", message: JSON.stringify(r.errors ?? "Create failed") });
          const savedId = target.creating ? String(r?.id ?? "") : target.id;
          if (target.creating && !savedId)
            return setStatus({ kind: "unknown", created: true, message: "Salesforce answered without a record id." });
          return reread(savedId).then(
            (rec) => landed(savedId, rec ?? {}),
            (e: unknown) => landed(savedId, null, `Saved, but the record couldn't be reloaded: ${errorText(e)}`),
          );
        },
        (e: unknown) => {
          const failure = classify(e);
          if (failure.definitive) return setStatus({ kind: "error", message: failure.message });
          if (target.creating) return setStatus({ kind: "unknown", created: true, message: failure.message });
          // an edit can be checked: a re-read showing every sent value counts as saved; anything else stays unknown
          // (the request may still land, or automation / another user changed the values)
          return reread(target.id).then(
            (now) => {
              const missed = notLanded(fields, sent, now ?? {});
              if (missed.length === 0) landed(target.id, now ?? {});
              else
                setStatus({
                  kind: "unknown",
                  created: false,
                  message: `${failure.message}; the record doesn't show ${missed.join(", ")} yet`,
                });
            },
            () => setStatus({ kind: "unknown", created: false, message: failure.message }),
          );
        },
      )
      .finally(settle);
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
          {creating ? `New ${desc?.label ?? sobject}` : `Edit ${recordName || id}`}
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
            {status.note ? <div className="sf-eyebrow">{status.note}</div> : null}
          </div>
        ) : null}
        {status.kind === "error" ? (
          <div className="sf-error" role="alert">
            <b>Couldn't save</b>
            {status.message}
          </div>
        ) : null}
        {status.kind === "unknown" ? (
          <div className="sf-error" role="alert">
            <b>Outcome unknown — check Salesforce before retrying</b>
            {status.created
              ? `The ${desc.label} may have been created anyway; retrying could create a duplicate.`
              : "It isn't confirmed whether the change landed; retrying may repeat its automation."}{" "}
            ({status.message})
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
                ? `${changed.length} field${changed.length === 1 ? "" : "s"} to save`
                : "No changes"}
          </span>
          <span className="sp" />
          <Button disabled={busy || !dirty} onClick={() => setValues({ ...original })}>
            {creating ? "Clear" : "Discard changes"}
          </Button>
          {status.kind === "unknown" ? (
            <Button danger disabled={busy || !dirty || missing.length > 0} onClick={() => save(true)}>
              Retry anyway
            </Button>
          ) : (
            <Button type="primary" loading={status.kind === "saving"} disabled={busy || !dirty || missing.length > 0} onClick={() => save()}>
              {creating ? "Create" : "Save"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
