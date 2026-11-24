/**
 * Machine-readable rendering of a comparison, for CI jobs and scripts.
 *
 * The shape is versioned by `schemaVersion`; fields are only ever added within
 * a version. Findings use the same order as the text report (BREAKING, then
 * UNKNOWN, then SAFE, keeping the engine's stable order inside each verdict),
 * so two runs on the same inputs produce byte-identical output.
 */
import type { LoadedContract } from "../contract.js";
import { overallVerdict, type Direction, type Finding, type RuleId, type Verdict } from "../rules/finding.js";
import { describeLocation } from "./text.js";

export const JSON_REPORT_VERSION = 1;

const VERDICT_ORDER: readonly Verdict[] = ["BREAKING", "UNKNOWN", "SAFE"];

export type FailOn = "breaking" | "unknown" | "never";

export interface JsonContract {
  readonly path: string;
  readonly kind: LoadedContract["kind"];
  readonly specVersion: string;
  readonly contractVersion: string | null;
  readonly hash: string;
}

export interface JsonFinding {
  readonly rule: RuleId;
  readonly verdict: Verdict;
  readonly direction: Direction;
  /** OpenAPI operation and part, e.g. `PUT /orders/{id} request body`; `null` outside `/paths`. */
  readonly location: string | null;
  readonly oldPointer: string;
  readonly newPointer: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly message: string;
}

export interface JsonDiffReport {
  readonly schemaVersion: typeof JSON_REPORT_VERSION;
  readonly status: "ok";
  readonly verdict: Verdict;
  readonly failOn: FailOn;
  /** True when a finding is at or above `failOn`; the CLI then exits 1. */
  readonly failed: boolean;
  readonly equivalent: boolean;
  readonly old: JsonContract;
  readonly new: JsonContract;
  readonly summary: { readonly total: number; readonly breaking: number; readonly unknown: number; readonly safe: number };
  readonly findings: readonly JsonFinding[];
}

export interface JsonError {
  /** The file the error is about; absent for errors about the pair. */
  readonly file?: string;
  readonly code: string;
  readonly message: string;
}

export interface JsonErrorReport {
  readonly schemaVersion: typeof JSON_REPORT_VERSION;
  readonly status: "error";
  readonly errors: readonly JsonError[];
}

/** Whether `verdict` meets the `failOn` threshold. */
export function failsPolicy(verdict: Verdict, failOn: FailOn): boolean {
  if (failOn === "never") return false;
  if (failOn === "unknown") return verdict !== "SAFE";
  return verdict === "BREAKING";
}

function contract(loaded: LoadedContract): JsonContract {
  return {
    path: loaded.path,
    kind: loaded.kind,
    specVersion: loaded.specVersion,
    contractVersion: loaded.contractVersion ?? null,
    hash: loaded.hash,
  };
}

function finding(entry: Finding): JsonFinding {
  return {
    rule: entry.rule,
    verdict: entry.verdict,
    direction: entry.direction,
    location: describeLocation(entry.oldPointer) ?? describeLocation(entry.newPointer) ?? null,
    oldPointer: entry.oldPointer,
    newPointer: entry.newPointer,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    message: entry.message,
  };
}

export function buildJsonReport(
  previous: LoadedContract,
  next: LoadedContract,
  findings: readonly Finding[],
  failOn: FailOn,
): JsonDiffReport {
  const verdict = overallVerdict(findings);
  const ordered = VERDICT_ORDER.flatMap((level) => findings.filter((entry) => entry.verdict === level));
  const count = (level: Verdict) => findings.filter((entry) => entry.verdict === level).length;
  return {
    schemaVersion: JSON_REPORT_VERSION,
    status: "ok",
    verdict,
    failOn,
    failed: failsPolicy(verdict, failOn),
    equivalent: previous.hash === next.hash,
    old: contract(previous),
    new: contract(next),
    summary: { total: findings.length, breaking: count("BREAKING"), unknown: count("UNKNOWN"), safe: count("SAFE") },
    findings: ordered.map(finding),
  };
}

export function buildJsonError(errors: readonly JsonError[]): JsonErrorReport {
  return { schemaVersion: JSON_REPORT_VERSION, status: "error", errors };
}

/** Pretty-printed JSON with a trailing newline. */
export function formatJson(report: JsonDiffReport | JsonErrorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
