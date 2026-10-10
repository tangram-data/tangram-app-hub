// Space choice for a new page: every space (cursor-paged), searchable, with retry when the list fails to load.
import { Button, Select } from "antd";
import React, { useCallback, useEffect, useState } from "react";
import { Space, allSpaces, errText } from "./composer-io";

export function SpacePicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (id: string) => void }) {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setSpaces(null);
    setError("");
    allSpaces().then(setSpaces, (e: unknown) => setError(errText(e)));
  }, []);
  useEffect(() => load(), [load]);
  return (
    <>
      <div className="a-field">
        <label htmlFor="cf-space">Space</label>
        <Select
          id="cf-space"
          style={{ minWidth: 260 }}
          placeholder={error ? "Couldn't load spaces" : "Choose a space"}
          loading={!spaces && !error}
          showSearch
          optionFilterProp="label"
          value={value || undefined}
          disabled={disabled}
          onChange={(v: string) => onChange(v)}
          options={(spaces ?? []).map((sp) => ({ value: sp.id, label: `${sp.name ?? sp.key} (${sp.key})` }))}
        />
      </div>
      {error ? (
        <div className="a-error">
          Couldn't load spaces: {error}{" "}
          <Button size="small" type="text" onClick={load}>
            Retry
          </Button>
        </div>
      ) : null}
    </>
  );
}
