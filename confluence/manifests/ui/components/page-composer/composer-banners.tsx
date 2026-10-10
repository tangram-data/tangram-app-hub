// The composer's outcome banners: errors, unknown create/update outcomes (with check / do-again-anyway), version
// conflicts and the saved confirmation.
import { Button } from "antd";
import React from "react";
import { openExternal } from "./composer-io";

export type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "busy" }
  | { kind: "saved"; title: string; url: string }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "uncertain"; message: string } // a create whose outcome is unknown
  | { kind: "unsure"; message: string }; // an update whose outcome is unknown

type Props = {
  status: Status;
  showError: boolean;
  againLabel: string;
  onCheckUpdate: () => void;
  onUpdateAgain: () => void;
  onCheckCreate: () => void;
  onCreateAgain: () => void;
  onReloadLatest: () => void;
};

export function StatusBanners({
  status,
  showError,
  againLabel,
  onCheckUpdate,
  onUpdateAgain,
  onCheckCreate,
  onCreateAgain,
  onReloadLatest,
}: Props) {
  return (
    <>
      {status.kind === "error" && showError ? <div className="a-error">{status.message}</div> : null}
      {status.kind === "unsure" ? (
        <div className="a-error" role="alert">
          Your change may already be saved: {status.message}{" "}
          <Button size="small" onClick={onCheckUpdate}>Check again</Button>{" "}
          <Button size="small" onClick={onUpdateAgain}>
            {againLabel}
          </Button>
        </div>
      ) : null}
      {status.kind === "uncertain" ? (
        <div className="a-error" role="alert">
          The page may already exist: {status.message}{" "}
          <Button size="small" onClick={onCheckCreate}>Check again</Button>{" "}
          <Button size="small" onClick={onCreateAgain}>Create again anyway</Button>
        </div>
      ) : null}
      {status.kind === "conflict" ? (
        <div className="a-error" role="alert">
          Someone changed this page since you opened it ({status.message}).{" "}
          <Button size="small" onClick={onReloadLatest}>Reload latest</Button>
        </div>
      ) : null}
      {status.kind === "saved" ? (
        <div className="a-ok">
          Saved “{status.title}”.{" "}
          {status.url ? (
            <a href={status.url} onClick={(e) => (e.preventDefault(), openExternal(status.url))}>
              Open in Confluence
            </a>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
