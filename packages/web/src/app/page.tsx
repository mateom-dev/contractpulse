import { ApiErrorPanel } from "../components/api-error";
import { api } from "../lib/api";
import { paths } from "../lib/format";

export default async function HomePage() {
  try {
    const client = api();
    const [workspace, services] = await Promise.all([client.workspace(), client.services()]);
    return (
      <>
        <h1>{workspace.name}</h1>
        <h2>Services</h2>
        {services.length === 0 ? (
          <p className="muted">No services registered yet. Create one and import a contract through the registry API.</p>
        ) : (
          <ul className="cards">
            {services.map((service) => (
              <li key={service.slug} className="card">
                <a href={paths.service(service.slug)}>
                  <strong>{service.name}</strong>
                </a>
                <code>{service.slug}</code>
                {service.description && <span>{service.description}</span>}
                <span className="muted">
                  {service.contractCount} contract{service.contractCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  } catch (error) {
    return <ApiErrorPanel error={error} />;
  }
}
