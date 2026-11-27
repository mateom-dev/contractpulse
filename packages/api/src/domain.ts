import type { ContractKind } from "@contractpulse/cli";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
}

/** Who is calling: the workspace their token belongs to and the token's label. */
export interface Caller {
  workspace: Workspace;
  tokenLabel: string;
}

export interface Service {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface ServiceSummary extends Service {
  contractCount: number;
}

export interface VersionSource {
  /** Path of the file in its repository, e.g. `contracts/orders.created.schema.json`. */
  path: string;
  repository: string | null;
  /** Branch, tag or commit the file was read from. */
  ref: string | null;
}

export interface VersionSummary {
  sequence: number;
  kind: ContractKind;
  declaredVersion: string | null;
  specVersion: string;
  hash: string;
  sizeBytes: number;
  source: VersionSource;
  importedBy: string;
  importedAt: Date;
}

export interface VersionDetail extends VersionSummary {
  /** The contract file exactly as it was imported. */
  content: string;
}

export interface ContractSummary {
  name: string;
  kind: ContractKind;
  versionCount: number;
  latest: VersionSummary | null;
  createdAt: Date;
}

export interface ServiceDetail extends Service {
  contracts: ContractSummary[];
}

export interface NewService {
  slug: string;
  name: string;
  description: string | null;
}

/** A parsed, validated contract file ready to be stored. */
export interface NewVersion {
  kind: ContractKind;
  declaredVersion: string | null;
  specVersion: string;
  hash: string;
  sizeBytes: number;
  content: string;
  source: VersionSource;
  importedBy: string;
}

export interface AddVersionResult {
  version: VersionSummary;
  /** False when the content matched the latest version, which is returned instead. */
  created: boolean;
}

/** A service as shown on either side of a dependency. */
export interface ServiceRef {
  slug: string;
  name: string;
}

/**
 * A registered consumer: `consumer` reads `contract` of `provider` and is known
 * to work with version `version.sequence`. `uses` lists the JSON Pointers into
 * that version the consumer relies on; empty means the whole contract.
 */
export interface Dependency {
  consumer: ServiceRef;
  provider: ServiceRef;
  contract: { name: string; kind: ContractKind; latestSequence: number };
  version: { sequence: number; hash: string; declaredVersion: string | null };
  uses: string[];
  note: string | null;
  recordedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DependencyKey {
  consumerSlug: string;
  providerSlug: string;
  contractName: string;
}

export interface NewDependency {
  versionSequence: number;
  /** Sorted, without duplicates. */
  uses: string[];
  note: string | null;
  recordedBy: string;
}

export interface PutDependencyResult {
  dependency: Dependency;
  /** False when an existing dependency was replaced. */
  created: boolean;
}
