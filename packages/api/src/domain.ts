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
