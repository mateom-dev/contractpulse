import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../../../../../components/api-error";
import { KindBadge } from "../../../../../../../components/badges";
import { ConsumerImpactCard, ImpactSummaryBar } from "../../../../../../../components/consumer-impact";
import { ApiError, api } from "../../../../../../../lib/api";
import {
  formatBytes,
  formatDate,
  formatSource,
  parseSequence,
  paths,
  shortHash,
} from "../../../../../../../lib/format";

export default async function VersionPage({
  params,
}: {
  params: Promise<{ service: string; contract: string; sequence: string }>;
}) {
  const { service, contract, sequence: raw } = await params;
  const sequence = parseSequence(raw);
  if (sequence === null) notFound();

  try {
    const client = api();
    const [version, impact, versions] = await Promise.all([
      client.version(service, contract, sequence),
      client.impact(service, contract, sequence),
      client.versions(service, contract),
    ]);
    const latest = versions[0]?.sequence;
    const previous = versions.find((v) => v.sequence < sequence)?.sequence;
    const next = [...versions].reverse().find((v) => v.sequence > sequence)?.sequence;

    return (
      <>
        <p className="crumbs">
          <a href={paths.home()}>Services</a> / <a href={paths.service(service)}>{service}</a> /{" "}
          <a href={paths.contract(service, contract)}>{contract}</a> /
        </p>
        <h1>
          {contract} v{version.sequence} <KindBadge kind={version.kind} />
          {version.sequence === latest && <span className="badge latest">latest</span>}
        </h1>
        <nav className="pager" aria-label="Versions">
          {previous !== undefined && <a href={paths.version(service, contract, previous)}>← v{previous}</a>}
          {next !== undefined && <a href={paths.version(service, contract, next)}>v{next} →</a>}
        </nav>

        <dl className="meta">
          <dt>Declared version</dt>
          <dd>{version.declaredVersion ?? "—"}</dd>
          <dt>Spec</dt>
          <dd>{version.specVersion}</dd>
          <dt>Canonical hash</dt>
          <dd>
            <code title={version.hash}>{shortHash(version.hash)}</code>
          </dd>
          <dt>Source</dt>
          <dd>
            <code>{formatSource(version.source)}</code>
          </dd>
          <dt>Imported</dt>
          <dd>
            {formatDate(version.importedAt)} by {version.importedBy} · {formatBytes(version.sizeBytes)}
          </dd>
        </dl>

        <h2>Impact on registered consumers</h2>
        <p className="muted">
          Each consumer is compared from the version it is pinned to up to v{version.sequence}; only findings that touch
          the fields it uses count against it.
        </p>
        <ImpactSummaryBar summary={impact.summary} />
        <p className="muted coverage">{impact.coverage}</p>
        {impact.consumers.length === 0 ? (
          <p className="muted">No consumers registered for this contract.</p>
        ) : (
          impact.consumers.map((entry) => (
            <ConsumerImpactCard
              key={entry.consumer.slug}
              impact={entry}
              provider={service}
              contract={contract}
              target={version.sequence}
            />
          ))
        )}

        <details className="panel file">
          <summary>Contract file as imported</summary>
          <pre>{version.content}</pre>
        </details>
      </>
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return <ApiErrorPanel error={error} />;
  }
}
