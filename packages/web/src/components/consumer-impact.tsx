import { paths, shortHash } from "../lib/format";
import type { ConsumerImpact, ImpactSummary } from "../lib/types";
import { StatusBadge } from "./badges";
import { FindingsTable } from "./findings-table";

export function ImpactSummaryBar({ summary }: { summary: ImpactSummary }) {
  return (
    <ul className="summary" aria-label="Impact summary">
      <li>
        <strong>{summary.consumers}</strong> registered consumer{summary.consumers === 1 ? "" : "s"}
      </li>
      <li className="status-breaking">
        <strong>{summary.breaking}</strong> breaking
      </li>
      <li className="status-review">
        <strong>{summary.review}</strong> need review
      </li>
      <li className="status-safe">
        <strong>{summary.safe}</strong> safe
      </li>
    </ul>
  );
}

/** Why a consumer got its status, in one sentence. */
export function impactReason(impact: ConsumerImpact): string {
  if (impact.upToDate) return "Pinned to the same content as this version.";
  const parts: string[] = [];
  if (impact.findings.length > 0) {
    const one = impact.findings.length === 1;
    parts.push(`${impact.findings.length} finding${one ? " touches" : "s touch"} what it uses`);
  }
  if (impact.missingPointers.length > 0) {
    parts.push(`${impact.missingPointers.length} used field${impact.missingPointers.length === 1 ? " is" : "s are"} missing`);
  }
  if (parts.length === 0) parts.push("No change touches what it uses");
  const unrelated =
    impact.unrelatedFindings > 0
      ? ` ${impact.unrelatedFindings} other change${impact.unrelatedFindings === 1 ? " between the versions doesn't" : "s between the versions don't"} affect it.`
      : "";
  return `${parts.join("; ")}.${unrelated}`;
}

export function ConsumerImpactCard({
  impact,
  provider,
  contract,
  target,
}: {
  impact: ConsumerImpact;
  provider: string;
  contract: string;
  /** Sequence of the version the consumer is compared with. */
  target: number;
}) {
  const { consumer, pinned } = impact;
  return (
    <section className={`panel impact impact-${impact.status}`} id={`consumer-${consumer.slug}`} aria-labelledby={`consumer-${consumer.slug}-title`}>
      <header className="impact-header">
        <h3 id={`consumer-${consumer.slug}-title`}>
          <a href={paths.service(consumer.slug)}>{consumer.name}</a> <span className="muted">({consumer.slug})</span>
        </h3>
        <StatusBadge status={impact.status} />
      </header>
      <p className="muted">
        Pinned to{" "}
        <a href={paths.version(provider, contract, pinned.sequence)}>
          v{pinned.sequence}
          {pinned.declaredVersion ? ` (${pinned.declaredVersion})` : ""}
        </a>{" "}
        <code title={pinned.hash}>{shortHash(pinned.hash)}</code>, compared with v{target}. {impactReason(impact)}
      </p>
      <p>
        Uses:{" "}
        {impact.uses.length === 0 ? (
          <em>the whole contract</em>
        ) : (
          impact.uses.map((pointer) => (
            <code key={pointer} className={impact.missingPointers.includes(pointer) ? "pointer missing" : "pointer"}>
              {pointer}
            </code>
          ))
        )}
      </p>
      {impact.missingPointers.length > 0 && (
        <p className="warning">
          Not in v{target}:{" "}
          {impact.missingPointers.map((pointer) => (
            <code key={pointer}>{pointer}</code>
          ))}
        </p>
      )}
      <FindingsTable findings={impact.findings} caption={`Findings affecting ${consumer.slug}`} />
    </section>
  );
}
