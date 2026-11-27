import type {
  ConsumersResponse,
  Dependency,
  ServiceDetail,
  ServiceSummary,
  StoredImpact,
  VersionDetail,
  VersionSummary,
  Workspace,
} from "./types";

/** An API call that did not return 2xx, the API could not be reached, or the UI isn't configured. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiConfig {
  /** Base URL of the registry API, without a trailing slash. */
  baseUrl: string;
  /** Slug of the workspace the UI shows. */
  workspace: string;
  /** Bearer token for that workspace; read on the server only. */
  token: string | null;
}

export const DEFAULT_API_URL = "http://127.0.0.1:3001";
export const DEFAULT_WORKSPACE = "demo";

export function apiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return {
    baseUrl: (env["CONTRACTPULSE_API_URL"]?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
    workspace: env["CONTRACTPULSE_WORKSPACE"]?.trim() || DEFAULT_WORKSPACE,
    token: env["CONTRACTPULSE_API_TOKEN"]?.trim() || null,
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Typed client for the registry routes the UI reads. Runs in server
 * components only, so the token never reaches the browser.
 */
export function createApiClient(config: ApiConfig, fetchImpl: FetchLike = fetch) {
  async function get<T>(segments: readonly string[], query: Record<string, string | number | undefined> = {}) {
    if (!config.token) {
      throw new ApiError(401, "NO_TOKEN", "CONTRACTPULSE_API_TOKEN is not set");
    }
    const path = ["v1", "workspaces", config.workspace, ...segments].map(encodeURIComponent).join("/");
    const url = new URL(`${config.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json", authorization: `Bearer ${config.token}` },
        cache: "no-store",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiError(502, "API_UNREACHABLE", `Cannot reach the API at ${config.baseUrl}: ${reason}`);
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      throw new ApiError(
        response.status,
        typeof envelope?.code === "string" ? envelope.code : "HTTP_ERROR",
        typeof envelope?.message === "string" ? envelope.message : `API returned ${response.status}`,
      );
    }
    return body as T;
  }

  const contractPath = (service: string, contract: string) => ["services", service, "contracts", contract];

  return {
    workspace: async () => (await get<{ workspace: Workspace }>([])).workspace,
    services: async () => (await get<{ services: ServiceSummary[] }>(["services"])).services,
    service: async (service: string) => (await get<{ service: ServiceDetail }>(["services", service])).service,
    dependencies: async (service: string) =>
      (await get<{ dependencies: Dependency[] }>(["services", service, "dependencies"])).dependencies,
    versions: async (service: string, contract: string) =>
      (await get<{ versions: VersionSummary[] }>([...contractPath(service, contract), "versions"])).versions,
    version: async (service: string, contract: string, sequence: number) =>
      (await get<{ version: VersionDetail }>([...contractPath(service, contract), "versions", String(sequence)]))
        .version,
    consumers: (service: string, contract: string) =>
      get<ConsumersResponse>([...contractPath(service, contract), "consumers"]),
    impact: (service: string, contract: string, version?: number) =>
      get<StoredImpact>([...contractPath(service, contract), "impact"], { version }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api = (): ApiClient => createApiClient(apiConfig());
