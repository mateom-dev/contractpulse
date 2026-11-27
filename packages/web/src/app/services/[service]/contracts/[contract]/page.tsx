import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../../../components/api-error";
import { KindBadge } from "../../../../../components/badges";
import { ApiError, api } from "../../../../../lib/api";
import { formatBytes, formatDate, formatSource, paths, shortHash } from "../../../../../lib/format";

export default async function ContractPage({ params }: { params: Promise<{ service: string; contract: string }> }) {
  const { service, contract } = await params;
  try {
    const client = api();
    const [versions, { consumers, coverage }] = await Promise.all([
      client.versions(service, contract),
      client.consumers(service, contract),
    ]);
    const latest = versions[0];
    return (
      <>
        <p className="crumbs">
          <a href={paths.home()}>Services</a> / <a href={paths.service(service)}>{service}</a> /
        </p>
        <h1>
          {contract} {latest && <KindBadge kind={latest.kind} />}
        </h1>
        {latest && (
          <p>
            <a className="button" href={paths.version(service, contract, latest.sequence)}>
              Impact of the latest version (v{latest.sequence})
            </a>
          </p>
        )}

        <h2>Version history</h2>
        {versions.length === 0 ? (
          <p className="muted">No versions imported yet.</p>
        ) : (
          <table data-testid="versions">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Declared</th>
                <th scope="col">Hash</th>
                <th scope="col">Source</th>
                <th scope="col" className="num">
                  Size
                </th>
                <th scope="col">Imported</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.sequence}>
                  <td>
                    <a href={paths.version(service, contract, version.sequence)}>v{version.sequence}</a>
                  </td>
                  <td>{version.declaredVersion ?? "—"}</td>
                  <td>
                    <code title={version.hash}>{shortHash(version.hash)}</code>
                  </td>
                  <td>
                    <code>{formatSource(version.source)}</code>
                  </td>
                  <td className="num">{formatBytes(version.sizeBytes)}</td>
                  <td>
                    {formatDate(version.importedAt)} <span className="muted">by {version.importedBy}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Registered consumers</h2>
        <p className="muted coverage">{coverage}</p>
        {consumers.length === 0 ? (
          <p className="muted">No consumers registered for this contract.</p>
        ) : (
          <table data-testid="consumers">
            <thead>
              <tr>
                <th scope="col">Consumer</th>
                <th scope="col">Pinned version</th>
                <th scope="col">Uses</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {consumers.map((dependency) => (
                <tr key={dependency.consumer.slug}>
                  <td>
                    <a href={paths.service(dependency.consumer.slug)}>{dependency.consumer.name}</a>
                  </td>
                  <td>
                    <a href={paths.version(service, contract, dependency.version.sequence)}>
                      v{dependency.version.sequence}
                    </a>
                  </td>
                  <td>
                    {dependency.uses.length === 0 ? (
                      <em>whole contract</em>
                    ) : (
                      dependency.uses.map((pointer) => (
                        <code key={pointer} className="pointer">
                          {pointer}
                        </code>
                      ))
                    )}
                  </td>
                  <td>{dependency.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return <ApiErrorPanel error={error} />;
  }
}
