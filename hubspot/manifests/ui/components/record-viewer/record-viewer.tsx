// A HubSpot CRM record (contact, company, deal or ticket) laid out like HubSpot's record page:
// header, an "About" card of key properties (option labels, owner names, stage labels resolved),
// and association cards listing up to 5 linked records each. A linked record emits `open`.
import { Skeleton } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/hubspot.css";
import "../../shared/tangram-buttons.css";
import {
  avatarColor,
  call,
  CrmRecord,
  displayValue,
  errorText,
  initials,
  OBJECT_TYPES,
  ObjectType,
  Owner,
  owners,
  pipelines,
  properties,
  PropertyDef,
  RESOURCE,
  recordTitle,
  SINGULAR,
  TITLE_PROPS,
} from "../../shared/hubspot-crm";

const tangram = (window as any).tangram;

// Key properties per object type, in display order.
const ABOUT: Record<ObjectType, string[]> = {
  contacts: ["email", "phone", "jobtitle", "company", "lifecyclestage", "hs_lead_status", "hubspot_owner_id", "createdate", "lastmodifieddate"],
  companies: ["domain", "industry", "phone", "city", "state", "country", "numberofemployees", "annualrevenue", "lifecyclestage", "hubspot_owner_id", "createdate"],
  deals: ["amount", "dealstage", "pipeline", "closedate", "dealtype", "hubspot_owner_id", "createdate", "hs_lastmodifieddate"],
  tickets: ["hs_pipeline_stage", "hs_pipeline", "hs_ticket_priority", "hubspot_owner_id", "content", "createdate", "hs_lastmodifieddate"],
};
const EXTRA_PROPS = ["deal_currency_code", ...new Set(Object.values(TITLE_PROPS).flat())];
const ASSOC_LIMIT = 5;

// more = HubSpot has further association pages, so total is a lower bound.
type Linked = { type: ObjectType; total: number; more?: boolean; items: { id: string; title: string; sub: string }[]; error?: string };
type Loaded = {
  type: ObjectType;
  record: CrmRecord;
  defs: Map<string, PropertyDef>;
  owners: Map<string, Owner>;
  stages: Map<string, string>;
  pipelineLabels: Map<string, string>;
  linked: Linked[];
};

function asType(v: unknown): ObjectType | null {
  const s = String(v ?? "").toLowerCase();
  return (OBJECT_TYPES as string[]).includes(s) ? (s as ObjectType) : null;
}

function subtitle(type: ObjectType, p: Record<string, string | null> | undefined): string {
  if (type === "contacts") return [p?.jobtitle, p?.company].filter(Boolean).join(" · ") || p?.email || "";
  if (type === "companies") return p?.domain ?? "";
  if (type === "deals") return p?.amount ? `Amount ${new Intl.NumberFormat().format(Number(p.amount))}` : "";
  return "";
}

async function loadLinked(type: ObjectType, ids: string[], more: boolean): Promise<Linked> {
  const items = await Promise.all(
    ids.slice(0, ASSOC_LIMIT).map((id) =>
      call<CrmRecord>(RESOURCE[type], "Get", { parameters: { id, properties: TITLE_PROPS[type].join(",") } }).then(
        (r) => ({ id, title: recordTitle(type, r?.properties, id), sub: subtitle(type, r?.properties) }),
        () => ({ id, title: `${SINGULAR[type]} ${id}`, sub: "" }),
      ),
    ),
  );
  return { type, total: ids.length, more, items };
}

async function load(type: ObjectType, id: string): Promise<Loaded> {
  const others = OBJECT_TYPES.filter((t) => t !== type);
  const [record, defs, ownerMap] = await Promise.all([
    call<CrmRecord>(RESOURCE[type], "Get", {
      parameters: { id, properties: [...new Set([...ABOUT[type], ...EXTRA_PROPS])].join(","), associations: others.join(",") },
    }),
    properties(type).catch(() => new Map<string, PropertyDef>()),
    owners().catch(() => new Map<string, Owner>()),
  ]);
  const stages = new Map<string, string>();
  const pipelineLabels = new Map<string, string>();
  if (type === "deals" || type === "tickets") {
    const ps = await pipelines(type).catch(() => []);
    ps.forEach((p) => {
      pipelineLabels.set(p.id, p.label);
      (p.stages ?? []).forEach((s) => stages.set(s.id, s.label));
    });
  }
  // Association keys can be the plural type or a labelled variant ("contact_to_company"): match by prefix.
  const linked = await Promise.all(
    others.map((t) => {
      const groups = Object.entries(record?.associations ?? {}).filter(([k]) => k === t || k.startsWith(t));
      const ids = groups.flatMap(([, v]) => (v?.results ?? []).map((r) => String(r.id)));
      const more = groups.some(([, v]) => Boolean((v as { paging?: { next?: unknown } })?.paging?.next));
      return loadLinked(t, [...new Set(ids)], more).catch((e) => ({ type: t, total: 0, items: [], error: errorText(e) }));
    }),
  );
  return { type, record, defs, owners: ownerMap, stages, pipelineLabels, linked };
}

export default function RecordViewer() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: Loaded }>({
    kind: "loading",
  });
  const seq = useRef(0);

  const open = useCallback((rawType: unknown, rawId: unknown) => {
    const n = ++seq.current;
    const type = asType(rawType);
    const id = String(rawId ?? "").trim();
    if (!type || !id) {
      setState({ kind: "error", message: "Pass objectType (contacts, companies, deals or tickets) and a record id." });
      return;
    }
    setState({ kind: "loading" });
    load(type, id).then(
      (data) => n === seq.current && setState({ kind: "ready", data }),
      (e) => n === seq.current && setState({ kind: "error", message: errorText(e) }),
    );
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => open(inputs?.objectType, inputs?.id);
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [open]);

  if (state.kind === "loading")
    return (
      <div className="hs-root" style={{ padding: 16 }}>
        <Skeleton active avatar paragraph={{ rows: 6 }} />
      </div>
    );
  if (state.kind === "error")
    return (
      <div className="hs-root">
        <div className="hs-error">
          <b>Couldn't load the record</b>
          <div>{state.message}</div>
        </div>
      </div>
    );

  const { type, record, defs, stages, pipelineLabels, linked } = state.data;
  const p = record.properties ?? {};
  const title = recordTitle(type, p, record.id);
  const lookups = { owners: state.data.owners, stages, currency: p.deal_currency_code ?? undefined };
  const value = (name: string) =>
    name === "pipeline" || name === "hs_pipeline"
      ? (p[name] && pipelineLabels.get(p[name] as string)) || p[name] || ""
      : displayValue(name, p[name], defs.get(name), lookups);

  return (
    <div className="hs-root hs-record-wrap">
      <header className="hs-head">
        <span className="hs-avatar lg" style={{ background: avatarColor(title) }} aria-hidden="true">
          {initials(title)}
        </span>
        <div className="tx">
          <div className="hs-kind">{SINGULAR[type]}</div>
          <h1 className="t" title={title}>
            {title}
          </h1>
          {subtitle(type, p) ? <div className="s">{subtitle(type, p)}</div> : null}
        </div>
      </header>
      <div className="hs-record">
        <section className="hs-card" aria-label={`About this ${SINGULAR[type].toLowerCase()}`}>
          <div className="hs-card-h">About this {SINGULAR[type].toLowerCase()}</div>
          <div className="hs-props">
            {ABOUT[type].map((name) => {
              const v = value(name);
              return (
                <div className="hs-prop" key={name}>
                  <div className="k">{defs.get(name)?.label ?? name}</div>
                  <div className={v ? "v" : "v none"}>{v || "—"}</div>
                </div>
              );
            })}
          </div>
        </section>
        <aside className="hs-side">
          {linked.map((l) => (
            <section className="hs-card" key={l.type} aria-label={`Associated ${l.type}`}>
              <div className="hs-card-h">
                {SINGULAR[l.type]}s<span className="n">{l.more ? `${l.total}+` : l.total}</span>
              </div>
              {l.error ? (
                <div className="hs-error inline" style={{ margin: 10 }}>
                  {l.error}
                </div>
              ) : l.items.length === 0 ? (
                <div className="hs-faint" style={{ padding: "8px 14px" }}>
                  None associated
                </div>
              ) : (
                <ul className="hs-assoc">
                  {l.items.map((it) => (
                    <li key={it.id}>
                      <span className="hs-avatar sm" style={{ background: avatarColor(it.title) }} aria-hidden="true">
                        {initials(it.title)}
                      </span>
                      <span className="tx">
                        <button
                          type="button"
                          className="hs-linkbtn"
                          title={it.title}
                          onClick={() => tangram.emit("open", { objectType: l.type, id: it.id })}
                        >
                          {it.title}
                        </button>
                        {it.sub ? <span className="sub">{it.sub}</span> : null}
                      </span>
                    </li>
                  ))}
                  {l.total > l.items.length || l.more ? (
                    <li className="hs-faint">
                      and {l.total - l.items.length}
                      {l.more ? "+" : ""} more
                    </li>
                  ) : null}
                </ul>
              )}
            </section>
          ))}
        </aside>
      </div>
    </div>
  );
}
