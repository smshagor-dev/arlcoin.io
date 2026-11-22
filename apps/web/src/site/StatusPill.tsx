import type { Status } from "@/content/types.ts";

// The delivery status of a product, in the three words used across the site. The status itself
// comes from the content (docs/content-standard.md); this only names and colours it
// (globals.css, .status-pill).

const LABEL: Readonly<Record<Status, string>> = {
  LIVE: "Live",
  "IN DEVELOPMENT": "Building",
  PLANNED: "Planned",
};

const KIND: Readonly<Record<Status, string>> = {
  LIVE: "live",
  "IN DEVELOPMENT": "building",
  PLANNED: "planned",
};

export const statusLabel = (status: Status): string => LABEL[status];
/** `live`, `building` or `planned`: the value of `data-status` in the styles. */
export const statusKind = (status: Status): string => KIND[status];

export function StatusPill({ status, className = "" }: { status: Status; className?: string }) {
  return (
    <span className={`status-pill ${className}`} data-status={KIND[status]}>
      <span aria-hidden="true" className="status-dot" />
      {LABEL[status]}
    </span>
  );
}
