import { STATUS_LABEL, VERDICT_LABEL } from "../lib/format";
import type { ContractKind, ImpactStatus, Verdict } from "../lib/types";

export function StatusBadge({ status }: { status: ImpactStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`badge verdict-${verdict.toLowerCase()}`}>{VERDICT_LABEL[verdict]}</span>;
}

export function KindBadge({ kind }: { kind: ContractKind }) {
  return <span className="badge kind">{kind === "openapi" ? "OpenAPI" : "JSON Schema"}</span>;
}
