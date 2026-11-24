/**
 * Human-readable rendering of a comparison: one block per finding, worst
 * verdict first, each saying which side reads the data at that position.
 */
import type { LoadedContract } from "../contract.js";
import { canonicalJson } from "../engine/canonical.js";
import { overallVerdict, type Direction, type Finding, type Verdict } from "../rules/finding.js";

const VERDICT_ORDER: readonly Verdict[] = ["BREAKING", "UNKNOWN", "SAFE"];

const DIRECTION_LABELS: Record<Direction, string> = {
  request: "request (consumers write, producer reads)",
  response: "response (producer writes, consumers read)",
};

/** Values longer than this are cut so one finding stays a few lines long. */
export const MAX_VALUE_LENGTH = 120;

const INDENT = "          ";

function decodeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Where an OpenAPI pointer sits, e.g. `POST /orders request body` or
 * `GET /orders/{id} response 404`. `undefined` for anything outside `/paths`
 * (event schemas, shared components reached through a `$ref`).
 */
export function describeLocation(pointer: string): string | undefined {
  const tokens = pointer.split("/").slice(1).map(decodeToken);
  if (tokens[0] !== "paths" || tokens.length < 3) return undefined;
  const [, path, method, section, detail] = tokens;
  const operation = `${method?.toUpperCase()} ${path}`;
  if (section === "requestBody") return `${operation} request body`;
  if (section === "responses" && detail !== undefined) return `${operation} response ${detail}`;
  if (section === "parameters") return `${operation} parameter`;
  return operation;
}

/** Compact JSON for a finding value; `(absent)` for null, cut at `MAX_VALUE_LENGTH`. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(absent)";
  const text = canonicalJson(value);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

function describeContract(contract: LoadedContract): string {
  const version = contract.contractVersion ?? "unversioned";
  return `${contract.path} (${contract.kind} ${contract.specVersion}, version ${version})`;
}

function formatFinding(finding: Finding): string {
  const lines = [`${finding.verdict.padEnd(9)} ${finding.rule}`, `${INDENT}${finding.message}`];
  lines.push(`${INDENT}direction: ${DIRECTION_LABELS[finding.direction]}`);
  const location = describeLocation(finding.oldPointer) ?? describeLocation(finding.newPointer);
  if (location !== undefined) lines.push(`${INDENT}where:     ${location}`);
  if (finding.oldPointer === finding.newPointer) {
    lines.push(`${INDENT}at:        ${finding.oldPointer || "/"}`);
  } else {
    lines.push(`${INDENT}old at:    ${finding.oldPointer || "/"}`, `${INDENT}new at:    ${finding.newPointer || "/"}`);
  }
  lines.push(`${INDENT}- ${formatValue(finding.oldValue)}`, `${INDENT}+ ${formatValue(finding.newValue)}`);
  return lines.join("\n");
}

function count(findings: readonly Finding[], verdict: Verdict): number {
  return findings.filter((finding) => finding.verdict === verdict).length;
}

/**
 * Render a comparison of `previous` → `next`. Findings keep the engine's stable
 * order within each verdict; BREAKING come first, then UNKNOWN, then SAFE.
 */
export function formatDiff(previous: LoadedContract, next: LoadedContract, findings: readonly Finding[]): string {
  const header = [`old: ${describeContract(previous)}`, `     ${previous.hash}`];
  header.push(`new: ${describeContract(next)}`, `     ${next.hash}`);

  if (findings.length === 0) {
    const reason = previous.hash === next.hash ? "the contracts are equivalent" : "no rule matched a change";
    return `${header.join("\n")}\n\nNo differences found (${reason}).\nVerdict: SAFE\n`;
  }

  const blocks = VERDICT_ORDER.flatMap((verdict) =>
    findings.filter((finding) => finding.verdict === verdict).map(formatFinding),
  );
  const totals = VERDICT_ORDER.map((verdict) => `${count(findings, verdict)} ${verdict.toLowerCase()}`).join(", ");
  const noun = findings.length === 1 ? "finding" : "findings";
  return (
    `${header.join("\n")}\n\n${blocks.join("\n\n")}\n\n` +
    `Verdict: ${overallVerdict(findings)} (${findings.length} ${noun}: ${totals})\n`
  );
}
