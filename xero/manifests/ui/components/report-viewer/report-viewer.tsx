// A Xero financial report (profit and loss, balance sheet, trial balance)
// rendered from Xero's Reports[0].Rows: the Header row gives the columns,
// Section rows carry a title and nested rows, SummaryRows are totals. One
// bar on top switches report and dates and re-runs it.
import { ReloadOutlined } from "@ant-design/icons";
import { Button, DatePicker, Select, Skeleton, Tooltip } from "antd";
import dayjs from "dayjs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import "../../shared/tangram-buttons.css";
import "../../shared/xero.css";
import { errorText, money } from "../../shared/xero-format";

const tangram = (window as any).tangram;

type ReportKind = "ProfitAndLoss" | "BalanceSheet" | "TrialBalance";
type Cell = { Value?: string };
type Row = { RowType?: string; Title?: string; Cells?: Cell[]; Rows?: Row[] };
type Report = { ReportName?: string; ReportTitles?: string[]; ReportDate?: string; Rows?: Row[] };
type Params = { report: ReportKind; fromDate: string; toDate: string; date: string; periods?: number; timeframe?: string };

const KINDS: { value: ReportKind; label: string }[] = [
  { value: "ProfitAndLoss", label: "Profit and loss" },
  { value: "BalanceSheet", label: "Balance sheet" },
  { value: "TrialBalance", label: "Trial balance" },
];
const FMT = "YYYY-MM-DD";

function kindOf(v: unknown): ReportKind {
  return KINDS.some((k) => k.value === v) ? (v as ReportKind) : "ProfitAndLoss";
}

function isoOr(v: unknown, fallback: string): string {
  const d = dayjs(String(v ?? ""));
  return v && d.isValid() ? d.format(FMT) : fallback;
}

// The report action's query parameters for the current controls.
function query(p: Params): Record<string, unknown> {
  if (p.report === "ProfitAndLoss")
    return { fromDate: p.fromDate, toDate: p.toDate, periods: p.periods || undefined, timeframe: p.periods ? p.timeframe : undefined };
  if (p.report === "BalanceSheet")
    return { date: p.date, periods: p.periods || undefined, timeframe: p.periods ? p.timeframe : undefined };
  return { date: p.date };
}

// Numbers come as strings ("1234.50"); show them as money, anything else as is.
function cellText(v: string | undefined): string {
  if (v === undefined || v === "") return "";
  return /^-?\d+(\.\d+)?$/.test(v.trim()) ? money(Number(v)) : v;
}

const periodLabel = (n: number, tf: string) => `${n} ${tf.toLowerCase()}${n > 1 ? "s" : ""} back`;

// 1–3 periods back per timeframe, plus whatever the inputs asked for (Xero allows up to 11).
function compareOptions(p: Params): { value: string; label: string }[] {
  const opts = [
    { value: "none", label: "No comparison" },
    ...["MONTH", "QUARTER", "YEAR"].flatMap((tf) => [1, 2, 3].map((n) => ({ value: `${n}:${tf}`, label: periodLabel(n, tf) }))),
  ];
  const cur = p.periods ? `${p.periods}:${p.timeframe ?? "MONTH"}` : "none";
  if (!opts.some((o) => o.value === cur)) opts.push({ value: cur, label: periodLabel(p.periods ?? 1, p.timeframe ?? "MONTH") });
  return opts;
}

function Rows({ rows, cols, depth }: { rows: Row[]; cols: number; depth: number }) {
  return (
    <>
      {rows.map((r, i) => {
        if (r.RowType === "Section") {
          return (
            <React.Fragment key={`s${depth}-${i}`}>
              {r.Title ? (
                <tr className="sec">
                  <td colSpan={cols} title={r.Title}>
                    {r.Title}
                  </td>
                </tr>
              ) : null}
              <Rows rows={r.Rows ?? []} cols={cols} depth={depth + 1} />
            </React.Fragment>
          );
        }
        const cells = r.Cells ?? [];
        return (
          <tr key={`r${depth}-${i}`} className={r.RowType === "SummaryRow" ? "sum" : undefined}>
            {Array.from({ length: cols }, (_, c) => {
              const text = cellText(cells[c]?.Value);
              return c === 0 ? (
                <td key={c} title={text} style={{ paddingLeft: 12 + Math.min(depth, 3) * 8 }}>
                  {text}
                </td>
              ) : (
                <td key={c} className="num" title={text}>
                  {text}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}

export default function ReportViewer() {
  const today = dayjs();
  const [params, setParams] = useState<Params>({
    report: "ProfitAndLoss",
    fromDate: today.startOf("month").format(FMT),
    toDate: today.format(FMT),
    date: today.format(FMT),
  });
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const seq = useRef(0);

  const run = useCallback((p: Params) => {
    const mine = ++seq.current;
    setState("loading");
    setError("");
    tangram
      .performAction({ resourceType: "Report", action: p.report }, { parameters: query(p) })
      .then((r: { Reports?: Report[] }) => {
        if (mine !== seq.current) return;
        setReport(r?.Reports?.[0] ?? null);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setReport(null);
        setError(errorText(e));
        setState("error");
      });
  }, []);

  useEffect(() => {
    const apply = (inputs: Record<string, unknown>) => {
      const now = dayjs();
      const p: Params = {
        report: kindOf(inputs?.report),
        fromDate: isoOr(inputs?.fromDate, now.startOf("month").format(FMT)),
        toDate: isoOr(inputs?.toDate, now.format(FMT)),
        date: isoOr(inputs?.date, now.format(FMT)),
        periods: Number(inputs?.periods) || undefined,
        timeframe: ["MONTH", "QUARTER", "YEAR"].includes(String(inputs?.timeframe)) ? String(inputs?.timeframe) : "MONTH",
      };
      setParams(p);
      run(p);
    };
    apply(tangram.getInputs() ?? {});
    tangram.onInput((inputs: Record<string, unknown>) => apply(inputs ?? {}));
  }, [run]);

  const update = (patch: Partial<Params>) => {
    const p = { ...params, ...patch };
    setParams(p);
    run(p);
  };

  const rows = report?.Rows ?? [];
  const header = rows.find((r) => r.RowType === "Header")?.Cells ?? [];
  const body = rows.filter((r) => r.RowType !== "Header");
  const cols = Math.max(header.length, ...body.flatMap((r) => [r.Cells?.length ?? 0, ...(r.Rows ?? []).map((x) => x.Cells?.length ?? 0)]), 1);
  const titles = (report?.ReportTitles ?? []).filter(Boolean);
  const busy = state === "loading";

  return (
    <div className="x-root">
      <div className="x-accent" />
      <div className="x-bar">
        <span className="sum" title={titles.join(" · ")}>
          {titles.length ? titles.join(" · ") : KINDS.find((k) => k.value === params.report)?.label}
        </span>
        <span className="ctl">
          <Select
            size="small"
            value={params.report}
            options={KINDS}
            style={{ width: 150 }}
            aria-label="Report"
            onChange={(v) => update({ report: v })}
          />
          {params.report === "ProfitAndLoss" ? (
            <DatePicker.RangePicker
              size="small"
              allowClear={false}
              value={[dayjs(params.fromDate), dayjs(params.toDate)]}
              onChange={(v) => {
                if (v?.[0] && v?.[1]) update({ fromDate: v[0].format(FMT), toDate: v[1].format(FMT) });
              }}
            />
          ) : (
            <DatePicker
              size="small"
              allowClear={false}
              aria-label="As at"
              value={dayjs(params.date)}
              onChange={(v) => {
                if (v) update({ date: v.format(FMT) });
              }}
            />
          )}
          {params.report !== "TrialBalance" ? (
            <Select
              size="small"
              aria-label="Compare with"
              style={{ width: 150 }}
              value={params.periods ? `${params.periods}:${params.timeframe ?? "MONTH"}` : "none"}
              options={compareOptions(params)}
              onChange={(v: string) => {
                if (v === "none") update({ periods: undefined });
                else {
                  const [n, tf] = v.split(":");
                  update({ periods: Number(n), timeframe: tf });
                }
              }}
            />
          ) : null}
          <Tooltip title="Refresh">
            <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} aria-label="Refresh" disabled={busy} onClick={() => run(params)} />
          </Tooltip>
        </span>
      </div>
      {state === "error" ? (
        <div className="x-error">
          <b>Couldn't run the report</b>
          {error ? <div>{error}</div> : null}
        </div>
      ) : busy ? (
        <div className="x-pad">
          <Skeleton active title={false} paragraph={{ rows: 8 }} />
        </div>
      ) : body.length === 0 ? (
        <div className="x-empty">No figures for this period</div>
      ) : (
        <div className="x-scroll">
          {/* account names keep >= 200px; extra columns widen the table and the container scrolls */}
          <table className="x-table" style={{ minWidth: 200 + (cols - 1) * 128 }}>
            <colgroup>
              <col />
              {Array.from({ length: cols - 1 }, (_, i) => (
                <col key={i} style={{ width: 128 }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} className={c ? "num" : undefined} title={header[c]?.Value}>
                    {header[c]?.Value ?? ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Rows rows={body} cols={cols} depth={0} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
