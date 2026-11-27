import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../components/api-error";
import { KindBadge } from "../../../components/badges";
import { ApiError, api } from "../../../lib/api";
import { formatDate, paths, shortHash } from "../../../lib/format";

export default async function ServicePage({ params }: { params: Promise<{ service: string }> }) {
  const { service: slug } = await params;
  try {
    const client = api();
    const [service, dependencies] = await Promise.all([client.service(slug), client.dependencies(slug)]);
    return (
      <>
        <p className="crumbs">
          <a href={paths.home()}>Services</a> /
        </p>
        <h1>
          {service.name} <span className="muted">({service.slug})</span>
        </h1>
        {service.description && <p>{service.description}</p>}

        <h2>Contracts it provides</h2>
        {service.contracts.length === 0 ? (
          <p className="muted">No contracts imported yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Kind</th>
                <th scope="col" className="num">
                  Versions
                </th>
                <th scope="col">Latest</th>
                <th scope="col">Imported</th>
              </tr>
            </thead>
            <tbody>
              {service.contracts.map((contract) => (
                <tr key={contract.name}>
                  <td>
                    <a href={paths.contract(service.slug, contract.name)}>{contract.name}</a>
                  </td>
                  <td>
                    <KindBadge kind={contract.kind} />
                  </td>
                  <td className="num">{contract.versionCount}</td>
                  <td>
                    {contract.latest ? (
                      <a href={paths.version(service.slug, contract.name, contract.latest.sequence)}>
                        v{contract.latest.sequence}
                        {contract.latest.declaredVersion ? ` (${contract.latest.declaredVersion})` : ""}{" "}
                        <code>{shortHash(contract.latest.hash)}</code>
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{contract.latest ? formatDate(contract.latest.importedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Contracts it consumes</h2>
        {dependencies.length === 0 ? (
          <p className="muted">No dependencies registered for this service.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Contract</th>
                <th scope="col">Pinned version</th>
                <th scope="col">Uses</th>
              </tr>
            </thead>
            <tbody>
              {dependencies.map((dependency) => (
                <tr key={`${dependency.provider.slug}/${dependency.contract.name}`}>
                  <td>
                    <a href={paths.service(dependency.provider.slug)}>{dependency.provider.name}</a>
                  </td>
                  <td>
                    <a href={paths.contract(dependency.provider.slug, dependency.contract.name)}>
                      {dependency.contract.name}
                    </a>
                  </td>
                  <td>
                    <a href={paths.version(dependency.provider.slug, dependency.contract.name, dependency.version.sequence)}>
                      v{dependency.version.sequence}
                    </a>
                    {dependency.version.sequence < dependency.contract.latestSequence && (
                      <span className="muted"> (latest v{dependency.contract.latestSequence})</span>
                    )}
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
