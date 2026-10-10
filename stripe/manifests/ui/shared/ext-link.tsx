// External link for sandboxed components: popups are blocked in the frame, so clicks go through the host
// (tangram.openUrl, which accepts https only). Anything but a valid https URL renders as plain text.
import React from "react";
import { safeUrl } from "./stripe-format";

export default function ExtLink({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  const url = safeUrl(href);
  if (!url) return <>{children}</>;
  return (
    <a
      href={url}
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (window as any).tangram?.openUrl?.(url);
      }}
    >
      {children}
    </a>
  );
}
