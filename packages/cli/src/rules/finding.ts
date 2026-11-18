/**
 * Findings produced by comparing two versions of a contract.
 * See docs/rule-scope.md for the meaning of each verdict and direction.
 */

export type Verdict = "SAFE" | "BREAKING" | "UNKNOWN";

/**
 * Who reads the data at this position. `request`: the producer reads what
 * consumers send. `response`: consumers read what the producer sends (event
 * payloads are always `response`).
 */
export type Direction = "request" | "response";

export type RuleId =
  | "type.changed"
  | "type.widened"
  | "type.narrowed"
  /** A construct the engine cannot decide yet changed; CI defers to a reviewer. */
  | "schema.unsupported";

export interface Finding {
  readonly rule: RuleId;
  readonly verdict: Verdict;
  readonly direction: Direction;
  /** JSON Pointer in the old document, after following local `$ref`s. */
  readonly oldPointer: string;
  /** JSON Pointer in the new document, after following local `$ref`s. */
  readonly newPointer: string;
  /** Old value of whatever changed; `null` when it was absent. */
  readonly oldValue: unknown;
  /** New value of whatever changed; `null` when it is absent. */
  readonly newValue: unknown;
  readonly message: string;
}

const VERDICT_RANK: Record<Verdict, number> = { SAFE: 0, UNKNOWN: 1, BREAKING: 2 };

/** The worst verdict among `findings` (BREAKING > UNKNOWN > SAFE); SAFE when there are none. */
export function overallVerdict(findings: readonly Finding[]): Verdict {
  let worst: Verdict = "SAFE";
  for (const finding of findings) {
    if (VERDICT_RANK[finding.verdict] > VERDICT_RANK[worst]) worst = finding.verdict;
  }
  return worst;
}
