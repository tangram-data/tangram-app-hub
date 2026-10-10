// One describe-typed form control. Values use the API representation the
// connector sends: numbers, booleans, "YYYY-MM-DD" dates, ISO datetimes,
// picklist values, multipicklists joined with ";".
import { DatePicker, Input, InputNumber, Select, Switch } from "antd";
import dayjs from "dayjs";
import React from "react";
import { Field, parseDateTime } from "../../shared/sf-describe";

export function isLongText(f: Field): boolean {
  return f.type === "textarea" || (f.length ?? 0) > 255;
}

export default function FieldInput({
  f,
  value,
  disabled,
  onChange,
}: {
  f: Field;
  value: unknown;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = `sf-f-${f.name}`;
  const str = value === null || value === undefined ? "" : String(value);
  const options = (f.picklistValues ?? [])
    .filter((p) => p.active !== false)
    .map((p) => ({ value: p.value, label: p.label ?? p.value }));

  switch (f.type) {
    case "boolean":
      return <Switch id={id} checked={value === true} disabled={disabled} onChange={(on) => onChange(on)} />;
    case "currency":
    case "percent":
    case "double":
    case "int":
    case "long":
      return (
        <InputNumber
          id={id}
          style={{ width: "100%" }}
          value={value === null || value === undefined || value === "" ? null : Number(value)}
          precision={f.type === "int" || f.type === "long" ? 0 : undefined}
          addonAfter={f.type === "percent" ? "%" : undefined}
          disabled={disabled}
          onChange={(n) => onChange(n === null ? null : n)}
        />
      );
    case "date":
      return (
        <DatePicker
          id={id}
          style={{ width: "100%" }}
          value={str ? dayjs(str) : null}
          format="MMM D, YYYY"
          disabled={disabled}
          onChange={(d) => onChange(d ? d.format("YYYY-MM-DD") : null)}
        />
      );
    case "datetime":
      return (
        <DatePicker
          id={id}
          showTime={{ format: "h:mm A", use12Hours: true }}
          style={{ width: "100%" }}
          value={str ? parseDateTime(str) : null}
          format="MMM D, YYYY h:mm A"
          disabled={disabled}
          onChange={(d) => onChange(d ? d.toISOString() : null)}
        />
      );
    case "picklist":
      return (
        <Select
          id={id}
          style={{ width: "100%" }}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="--None--"
          value={str || undefined}
          options={options}
          disabled={disabled}
          onChange={(v) => onChange(v ?? null)}
        />
      );
    case "multipicklist":
      return (
        <Select
          id={id}
          mode="multiple"
          style={{ width: "100%" }}
          allowClear
          value={str ? str.split(";") : []}
          options={options}
          disabled={disabled}
          onChange={(vs: string[]) => onChange(vs.length ? vs.join(";") : null)}
        />
      );
    default:
      if (isLongText(f))
        return (
          <Input.TextArea
            id={id}
            autoSize={{ minRows: 2, maxRows: 8 }}
            maxLength={f.length || undefined}
            value={str}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      return (
        <Input
          id={id}
          type={f.type === "email" ? "email" : f.type === "url" ? "url" : f.type === "phone" ? "tel" : "text"}
          className={f.type === "reference" ? "sf-mono" : undefined}
          placeholder={f.type === "reference" ? `${f.referenceTo?.[0] ?? "Record"} id` : undefined}
          maxLength={f.length || undefined}
          value={str}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
