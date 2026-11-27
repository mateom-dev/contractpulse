import type {
  AddVersionResult,
  Caller,
  Dependency,
  DependencyKey,
  NewDependency,
  NewService,
  NewVersion,
  PutDependencyResult,
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

  /**
   * Record that the consumer service reads the provider's contract, replacing an
   * earlier record for the same pair. Throws NotFoundError for an unknown
   * consumer, provider or contract, SelfDependencyError when consumer and
   * provider are the same service, and UnknownVersionError when the contract
   * has no such version.
   */
  putDependency(workspaceId: string, key: DependencyKey, input: NewDependency): Promise<PutDependencyResult>;
  /** False when there was nothing to remove. */
  removeDependency(workspaceId: string, key: DependencyKey): Promise<boolean>;
  /** What the service consumes, by provider then contract; null for an unknown service. */
  listDependencies(workspaceId: string, consumerSlug: string): Promise<Dependency[] | null>;
  /** Registered consumers of a contract, by consumer slug; null for an unknown contract. */
  listConsumers(workspaceId: string, providerSlug: string, contractName: string): Promise<Dependency[] | null>;
}
