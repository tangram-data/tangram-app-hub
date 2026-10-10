// HubSpot deals as a read-only pipeline board: one column per stage (pipeline display order) with
// deal count and total amount, a card per deal (name, amount, close date, owner). Deals come from
// Deal.Find filtered to the pipeline (and optional owner), paged up to 1000. A card emits `open`.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Select, Skeleton, Tooltip } from "antd";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/hubspot.css";
import "../../shared/tangram-buttons.css";
import {
  avatarColor,
  call,
  CrmRecord,
  errorText,
  formatDate,
  formatMoney,
  initials,
  Owner,
  ownerName,
  owners,
  Pipeline,
  pipelines,
  Stage,
  recordTitle,
} from "../../shared/hubspot-crm";

const tangram = (window as any).tangram;

const PROPS = ["dealname", "amount", "dealstage", "closedate", "hubspot_owner_id", "deal_currency_code"];
const PAGE = 200;
const MAX_DEALS = 1000;
// Column for deals whose stage isn't in the (possibly stale) pipeline definition.
const OTHER = "__other__";

type Board = { pipeline: Pipeline; all: Pipeline[]; deals: CrmRecord[]; capped: boolean; owners: Map<string, Owner> };

async function fetchDeals(pipelineId: string, ownerId: string): Promise<{ deals: CrmRecord[]; capped: boolean }> {
  const filters = [{ propertyName: "pipeline", operator: "EQ", value: pipelineId }];
  if (ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId });
  const deals: CrmRecord[] = [];
  let after: string | undefined;
  for (;;) {
    const r = await call<{ results?: CrmRecord[]; paging?: { next?: { after?: string } } }>("Deal", "Find", {
      requestBody: {
        filterGroups: [{ filters }],
        properties: PROPS,
        sorts: [{ propertyName: "closedate", direction: "ASCENDING" }],
        limit: PAGE,
        ...(after ? { after } : {}),
      },
    });
    deals.push(...(r?.results ?? []));
    after = r?.paging?.next?.after;
    if (!after) return { deals, capped: false };
    if (deals.length >= MAX_DEALS) return { deals, capped: true };
  }
}

// Totals across currencies would be meaningless: one currency → formatted, mixed → plain sum flagged.
function total(deals: CrmRecord[]): string {
  const currencies = new Set(deals.map((d) => d.properties?.deal_currency_code).filter(Boolean) as string[]);
  const sum = deals.reduce((n, d) => n + (Number(d.properties?.amount) || 0), 0);
  if (currencies.size > 1) return `${formatMoney(sum)} (mixed currencies)`;
  return formatMoney(sum, [...currencies][0]);
}

export default function DealBoard() {
  const [inputs, setInputs] = useState({ pipelineId: "", ownerId: "" });
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; board: Board }>({
    kind: "loading",
  });
  const seq = useRef(0);

  const load = useCallback((pipelineId: string, ownerId: string, fresh = false) => {
    const n = ++seq.current;
    setState({ kind: "loading" });
    (async () => {
      const [all, ownerMap] = await Promise.all([pipelines("deals", fresh), owners().catch(() => new Map<string, Owner>())]);
      if (all.length === 0) throw new Error("This portal has no deal pipelines.");
      const pipeline = all.find((p) => p.id === pipelineId) ?? (pipelineId ? null : all[0]);
      if (!pipeline) throw new Error(`No deal pipeline with id ${pipelineId}.`);
      const { deals, capped } = await fetchDeals(pipeline.id, ownerId);
      return { pipeline, all, deals, capped, owners: ownerMap };
    })().then(
      (board) => n === seq.current && setState({ kind: "ready", board }),
      (e) => n === seq.current && setState({ kind: "error", message: errorText(e) }),
    );
  }, []);

  useEffect(() => {
    const apply = (i: Record<string, unknown>) => {
      const next = { pipelineId: String(i?.pipelineId ?? "").trim(), ownerId: String(i?.ownerId ?? "").trim() };
      setInputs(next);
      load(next.pipelineId, next.ownerId);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((i: Record<string, unknown>) => apply(i ?? {}));
  }, [load]);

  const busy = state.kind === "loading";
  const board = state.kind === "ready" ? state.board : null;
  const known = new Set((board?.pipeline.stages ?? []).map((s) => s.id));
  const ownerLabel = inputs.ownerId && board ? ownerName(board.owners.get(inputs.ownerId), inputs.ownerId) : "";

  return (
    <div className="hs-root">
      <div className="hs-bar">
        <span className="sum">
          {board
            ? `${board.deals.length}${board.capped ? "+" : ""} deals · ${total(board.deals)}${ownerLabel ? ` · owned by ${ownerLabel}` : ""}`
            : "Deals"}
        </span>
        {board && board.all.length > 1 ? (
          <Select
            size="small"
            style={{ width: 200 }}
            aria-label="Pipeline"
            value={board.pipeline.id}
            disabled={busy}
            options={board.all.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(id: string) => {
              setInputs((i) => ({ ...i, pipelineId: id }));
              load(id, inputs.ownerId);
            }}
          />
        ) : board ? (
          <span className="hs-faint">{board.pipeline.label}</span>
        ) : null}
        <Tooltip title="Refresh">
          <Button
            size="small"
            aria-label="Refresh"
            icon={<ReloadOutlined aria-hidden="true" />}
            disabled={busy}
            onClick={() => load(board?.pipeline.id ?? inputs.pipelineId, inputs.ownerId, true)}
          />
        </Tooltip>
      </div>
      {state.kind === "error" ? (
        <div className="hs-error">
          <b>Couldn't load the deal board</b>
          <div>{state.message}</div>
        </div>
      ) : !board ? (
        <div style={{ padding: 16 }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : (
        <>
          <div className="hs-board" role="list" aria-label={`${board.pipeline.label} stages`}>
            {[
              ...(board.pipeline.stages ?? []),
              ...(board.deals.some((d) => !known.has(d.properties?.dealstage ?? ""))
                ? [{ id: OTHER, label: "Other stage", displayOrder: 1e9 }]
                : []),
            ].map((stage: Stage) => {
              const deals = board.deals.filter((d) =>
                stage.id === OTHER ? !known.has(d.properties?.dealstage ?? "") : d.properties?.dealstage === stage.id,
              );
              const closed = stage.metadata?.isClosed === "true";
              const won = closed && Number(stage.metadata?.probability) >= 1;
              return (
                <section className="hs-col" role="listitem" key={stage.id} aria-label={stage.label}>
                  <div className="hs-col-h" style={closed ? { borderTopColor: won ? "#00bda5" : "#f2545b" } : undefined}>
                    <div className="l">
                      {stage.label}
                      <span className="c">{deals.length}</span>
                    </div>
                    <div className="tot">Total: {total(deals)}</div>
                  </div>
                  <div className="hs-col-b">
                    {deals.length === 0 ? <div className="hs-col-empty">No deals</div> : null}
                    {deals.map((d) => {
                      const p = d.properties ?? {};
                      const name = recordTitle("deals", p, d.id);
                      const owner = p.hubspot_owner_id ? ownerName(board.owners.get(p.hubspot_owner_id), p.hubspot_owner_id) : "";
                      return (
                        <button
                          type="button"
                          className="hs-deal"
                          key={d.id}
                          title={name}
                          onClick={() => tangram.emit("open", { objectType: "deals", id: d.id })}
                        >
                          <span className="nm">{name}</span>
                          <span className="row">
                            <span>{p.amount ? formatMoney(Number(p.amount), p.deal_currency_code ?? undefined) : "No amount"}</span>
                            <span className="sp" />
                            {owner ? (
                              <span className="hs-avatar sm" style={{ background: avatarColor(owner) }} title={owner} aria-label={owner}>
                                {initials(owner)}
                              </span>
                            ) : null}
                          </span>
                          {p.closedate ? <span className="row">Close date: {formatDate(p.closedate)}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
          {board.capped ? <div className="hs-more">Showing the first {board.deals.length} deals — narrow by owner to see the rest.</div> : null}
        </>
      )}
    </div>
  );
}
