/**
 * Change impact on registered consumers.
 *
 * Each consumer is checked against the version it was registered with: the
 * CLI's rules compare that pinned version with the target, and only findings
 * that touch what the consumer says it uses count against it. A consumer that
 * registered no `uses` relies on the whole contract, so every finding counts.
 *
 * Matching is deliberately generous: a finding counts when its pointer is the
 * used pointer, inside it, or above it (a removed or retyped parent breaks
 * every field below it). Used pointers are also matched after following local
 * `$ref`s, because findings point at the resolved schema. A used pointer that
 * no longer exists in the target makes the consumer need a review even when
 * no rule fired, so a gap in the rules can't hide a consumer.
 */
import {
  VERDICT_ORDER,
  compareContracts,
  getAtPointer,
  jsonFinding,
  overallVerdict,
  resolveRef,
  type Finding,
  type JsonFinding,
  type LoadedContract,
  type Verdict,
} from "@contractpulse/cli";
import type { Dependency } from "./domain.js";

/**
 * `breaking`: a BREAKING finding touches what the consumer uses.
 * `review`: an UNKNOWN finding does, or a used pointer is gone from the target.
 * `safe`: nothing the consumer uses changed incompatibly.
 */
export type ImpactStatus = "breaking" | "review" | "safe";

export interface ConsumerImpact {
  consumer: Dependency["consumer"];
  /** The version the consumer was registered with, which the target is compared against. */
  pinned: Dependency["version"];
  uses: string[];
  status: ImpactStatus;
  /** Pinned and target versions have the same canonical hash. */
  upToDate: boolean;
  /** Findings that touch what the consumer uses, BREAKING first. */
  findings: JsonFinding[];
  /** Findings between the two versions that don't touch what the consumer uses. */
  unrelatedFindings: number;
  /** Used pointers that don't exist in the target. */
  missingPointers: string[];
}

export interface ImpactSummary {
  consumers: number;
  breaking: number;
  review: number;
  safe: number;
}

export interface PinnedConsumer {
  dependency: Dependency;
  /** The consumer's pinned version, parsed. */
  pinned: LoadedContract;
}

const STATUS_ORDER: Record<ImpactStatus, number> = { breaking: 0, review: 1, safe: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Follow a local `$ref` at `pointer`, if there is one; `undefined` when it can't be followed. */
function followRef(document: unknown, pointer: string): string | undefined {
  const value = getAtPointer(document, pointer);
  if (!isRecord(value) || typeof value["$ref"] !== "string") return pointer;
  const resolved = resolveRef(document, value["$ref"]);
  return resolved.status === "local" ? resolved.target : undefined;
}

/**
 * The pointer after following every local `$ref` on the way, e.g.
 * `/properties/customer/properties/id` → `/$defs/Customer/properties/id`.
 * `undefined` when a step is missing or a reference can't be followed.
 */
export function resolvePointerPath(document: unknown, pointer: string): string | undefined {
  let path = followRef(document, "");
  if (path === undefined) return undefined;
  if (pointer === "") return path;
  for (const token of pointer.slice(1).split("/")) {
    path = `${path}/${token}`;
    if (getAtPointer(document, path) === undefined) return undefined;
    path = followRef(document, path);
    if (path === undefined) return undefined;
  }
  return path;
}

/** One pointer is the other or lies below it. */
function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Pointers a finding stands for. Requiredness findings point at the property,
 * but they are also a change to the parent's `required` list.
 */
function findingPointers(finding: Finding): string[] {
  const pointers = new Set([finding.oldPointer, finding.newPointer]);
  if (finding.rule === "required.added" || finding.rule === "required.removed") {
    for (const pointer of [finding.oldPointer, finding.newPointer]) {
      const match = /^(.*)\/properties\/[^/]+$/.exec(pointer);
      if (match) pointers.add(`${match[1]}/required`);
    }
  }
  return [...pointers];
}

function byVerdict(findings: readonly Finding[]): Finding[] {
  return VERDICT_ORDER.flatMap((verdict) => findings.filter((finding) => finding.verdict === verdict));
}

const STATUS_FOR: Record<Verdict, ImpactStatus> = { BREAKING: "breaking", UNKNOWN: "review", SAFE: "safe" };

/** Impact of `target` on one consumer. Throws CompareError when the kinds differ. */
export function consumerImpact(target: LoadedContract, entry: PinnedConsumer): ConsumerImpact {
  const { dependency, pinned } = entry;
  const findings = compareContracts(pinned, target);

  let relevant: Finding[];
  let missingPointers: string[] = [];
  if (dependency.uses.length === 0) {
    relevant = findings;
  } else {
    const used = dependency.uses.flatMap((pointer) => {
      const resolved = resolvePointerPath(pinned.document, pointer);
      return resolved === undefined || resolved === pointer ? [pointer] : [pointer, resolved];
    });
    relevant = findings.filter((finding) =>
      findingPointers(finding).some((pointer) => used.some((use) => related(pointer, use))),
    );
    missingPointers = dependency.uses.filter((pointer) => getAtPointer(target.document, pointer) === undefined);
  }

  let status = STATUS_FOR[overallVerdict(relevant)];
  if (status === "safe" && missingPointers.length > 0) status = "review";

  return {
    consumer: dependency.consumer,
    pinned: dependency.version,
    uses: dependency.uses,
    status,
    upToDate: pinned.hash === target.hash,
    findings: byVerdict(relevant).map(jsonFinding),
    unrelatedFindings: findings.length - relevant.length,
    missingPointers,
  };
}

/** Impact on every consumer, most affected first, then by consumer slug. */
export function computeImpact(
  target: LoadedContract,
  consumers: readonly PinnedConsumer[],
): { summary: ImpactSummary; consumers: ConsumerImpact[] } {
  const impacts = consumers
    .map((entry) => consumerImpact(target, entry))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        (a.consumer.slug < b.consumer.slug ? -1 : a.consumer.slug > b.consumer.slug ? 1 : 0),
    );
  const count = (status: ImpactStatus) => impacts.filter((impact) => impact.status === status).length;
  return {
    summary: { consumers: impacts.length, breaking: count("breaking"), review: count("review"), safe: count("safe") },
    consumers: impacts,
  };
}
