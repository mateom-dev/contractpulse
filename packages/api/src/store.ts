import type {
  AddVersionResult,
  Caller,
  NewService,
  NewVersion,
  Service,
  ServiceDetail,
  ServiceSummary,
  VersionDetail,
  VersionSummary,
} from "./domain.js";

/**
 * Persistence for the registry. Every read and write takes the caller's
 * workspace id, and implementations must never return rows of another workspace.
 */
export interface RegistryStore {
  /** Resolve a SHA-256 token hash to its workspace; null if unknown or revoked. */
  findCaller(tokenHash: string): Promise<Caller | null>;

  listServices(workspaceId: string): Promise<ServiceSummary[]>;
  /** Throws SlugTakenError when the slug is already used in the workspace. */
  createService(workspaceId: string, input: NewService): Promise<Service>;
  findService(workspaceId: string, serviceSlug: string): Promise<ServiceDetail | null>;

  /**
   * Append a version to `contractName` of the service, creating the contract on
   * its first import. Content equal (by hash) to the latest version returns that
   * version with `created: false`. Throws NotFoundError for an unknown service and
   * KindMismatchError when the contract already holds the other kind.
   */
  addVersion(
    workspaceId: string,
    serviceSlug: string,
    contractName: string,
    input: NewVersion,
  ): Promise<AddVersionResult>;
  /** Newest first; null when the service or contract does not exist. */
  listVersions(workspaceId: string, serviceSlug: string, contractName: string): Promise<VersionSummary[] | null>;
  findVersion(
    workspaceId: string,
    serviceSlug: string,
    contractName: string,
    sequence: number,
  ): Promise<VersionDetail | null>;
}
