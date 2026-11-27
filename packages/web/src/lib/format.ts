import type { Finding, ImpactStatus, Verdict, VersionSource } from "./types";

/** `sha256:3f9a…` → `3f9a1c2b7e04`, enough to tell versions apart at a glance. */
export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 12);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** UTC so the server-rendered page reads the same everywhere. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `contracts/x.json @ main (acme/orders)`. */
export function formatSource(source: VersionSource): string {
  let text = source.path;
  if (source.ref) text += ` @ ${source.ref}`;
  if (source.repository) text += ` (${source.repository})`;
  return text;
}

/** JSON value as compact text for a table cell; `null` from the API means "not present". */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** The pointer to show for a finding: one when both sides agree, `old → new` otherwise. */
export function findingField(finding: Pick<Finding, "oldPointer" | "newPointer">): string {
  const show = (pointer: string) => pointer || "/";
  return finding.oldPointer === finding.newPointer
    ? show(finding.oldPointer)
    : `${show(finding.oldPointer)} → ${show(finding.newPointer)}`;
}

/** Last property name in a pointer, e.g. `/properties/orderId` → `orderId`. */
export function fieldName(pointer: string): string | null {
  const match = /\/properties\/([^/]+)$/.exec(pointer);
  return match?.[1] ? match[1].replace(/~1/g, "/").replace(/~0/g, "~") : null;
}

export const STATUS_LABEL: Record<ImpactStatus, string> = {
  breaking: "Breaking",
  review: "Needs review",
  safe: "Safe",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  BREAKING: "BREAKING",
  UNKNOWN: "UNKNOWN",
  SAFE: "SAFE",
};

/** Positive integer from a route segment or query value; `null` for anything else. */
export function parseSequence(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const value = Number(raw);
  return value <= 2_147_483_647 ? value : null;
}

/** Links between the UI's pages. Slugs and contract names are URL-safe, but encode anyway. */
export const paths = {
  home: () => "/",
  service: (service: string) => `/services/${encodeURIComponent(service)}`,
  contract: (service: string, contract: string) =>
    `/services/${encodeURIComponent(service)}/contracts/${encodeURIComponent(contract)}`,
  version: (service: string, contract: string, sequence: number) =>
    `${paths.contract(service, contract)}/versions/${sequence}`,
};
