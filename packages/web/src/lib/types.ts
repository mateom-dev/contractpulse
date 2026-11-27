/**
 * Shapes of the registry API responses the UI reads (see packages/api).
 * Dates arrive as ISO strings.
 */

export type ContractKind = "openapi" | "json-schema";
export type Verdict = "BREAKING" | "UNKNOWN" | "SAFE";
export type Direction = "request" | "response";
export type ImpactStatus = "breaking" | "review" | "safe";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
}

export interface ServiceSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  contractCount: number;
}

export interface VersionSource {
  path: string;
  repository: string | null;
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
  importedAt: string;
}

export interface VersionDetail extends VersionSummary {
  content: string;
}

export interface ContractSummary {
  name: string;
  kind: ContractKind;
  versionCount: number;
  latest: VersionSummary | null;
  createdAt: string;
}

export interface ServiceDetail extends Omit<ServiceSummary, "contractCount"> {
  contracts: ContractSummary[];
}

export interface ServiceRef {
  slug: string;
  name: string;
}

export interface Dependency {
  consumer: ServiceRef;
  provider: ServiceRef;
  contract: { name: string; kind: ContractKind; latestSequence: number };
  version: { sequence: number; hash: string; declaredVersion: string | null };
  uses: string[];
  note: string | null;
  recordedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One rule finding, as in `contractpulse diff --format json`. */
export interface Finding {
  rule: string;
  verdict: Verdict;
  direction: Direction;
  location: string | null;
  oldPointer: string;
  newPointer: string;
  oldValue: unknown;
  newValue: unknown;
  message: string;
}

export interface ConsumerImpact {
  consumer: ServiceRef;
  pinned: Dependency["version"];
  uses: string[];
  status: ImpactStatus;
  upToDate: boolean;
  findings: Finding[];
  unrelatedFindings: number;
  missingPointers: string[];
}

export interface ImpactSummary {
  consumers: number;
  breaking: number;
  review: number;
  safe: number;
}

export interface StoredImpact {
  target: { stored: true; version: VersionSummary };
  summary: ImpactSummary;
  consumers: ConsumerImpact[];
  coverage: string;
}

export interface ConsumersResponse {
  consumers: Dependency[];
  coverage: string;
}
