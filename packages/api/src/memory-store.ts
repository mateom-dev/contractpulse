import { randomUUID } from "node:crypto";
import type { ContractKind } from "@contractpulse/cli";
import type {
  AddVersionResult,
  Caller,
  ContractSummary,
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
  Workspace,
} from "./domain.js";
import {
  KindMismatchError,
  NotFoundError,
  SelfDependencyError,
  SlugTakenError,
  UnknownVersionError,
} from "./errors.js";
import type { RegistryStore } from "./store.js";
import { hashToken } from "./tokens.js";

interface StoredService extends Service {
  workspaceId: string;
}

interface StoredContract {
  id: string;
  workspaceId: string;
  serviceId: string;
  name: string;
  kind: ContractKind;
  createdAt: Date;
  versions: VersionDetail[];
}

interface StoredDependency {
  workspaceId: string;
  consumerServiceId: string;
  contractId: string;
  versionSequence: number;
  uses: string[];
  note: string | null;
  recordedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byProviderThenContract = (a: Dependency, b: Dependency) =>
  compare(a.provider.slug, b.provider.slug) || compare(a.contract.name, b.contract.name);

function summary(version: VersionDetail): VersionSummary {
  return {
    sequence: version.sequence,
    kind: version.kind,
    declaredVersion: version.declaredVersion,
    specVersion: version.specVersion,
    hash: version.hash,
    sizeBytes: version.sizeBytes,
    source: { ...version.source },
    importedBy: version.importedBy,
    importedAt: version.importedAt,
  };
}

/** In-memory RegistryStore for tests and the local demo. Same rules as the PostgreSQL store. */
export class MemoryRegistryStore implements RegistryStore {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly tokens = new Map<string, { workspaceId: string; label: string; revoked: boolean }>();
  private readonly services: StoredService[] = [];
  private readonly contracts: StoredContract[] = [];
  private readonly dependencies: StoredDependency[] = [];
  private clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  addWorkspace(slug: string, name: string): Workspace {
    const workspace = { id: randomUUID(), slug, name };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  addToken(workspaceId: string, token: string, label: string, options: { revoked?: boolean } = {}): void {
    this.tokens.set(hashToken(token), { workspaceId, label, revoked: options.revoked ?? false });
  }

  async findCaller(tokenHash: string): Promise<Caller | null> {
    const token = this.tokens.get(tokenHash);
    if (!token || token.revoked) return null;
    const workspace = this.workspaces.get(token.workspaceId);
    return workspace ? { workspace: { ...workspace }, tokenLabel: token.label } : null;
  }

  async listServices(workspaceId: string): Promise<ServiceSummary[]> {
    return this.services
      .filter((service) => service.workspaceId === workspaceId)
      .sort((a, b) => (a.slug < b.slug ? -1 : 1))
      .map((service) => ({
        ...this.publicService(service),
        contractCount: this.contracts.filter((contract) => contract.serviceId === service.id).length,
      }));
  }

  async createService(workspaceId: string, input: NewService): Promise<Service> {
    if (this.service(workspaceId, input.slug)) throw new SlugTakenError(input.slug);
    const service: StoredService = { id: randomUUID(), workspaceId, ...input, createdAt: this.clock() };
    this.services.push(service);
    return this.publicService(service);
  }

  async findService(workspaceId: string, serviceSlug: string): Promise<ServiceDetail | null> {
    const service = this.service(workspaceId, serviceSlug);
    if (!service) return null;
    const contracts: ContractSummary[] = this.contracts
      .filter((contract) => contract.serviceId === service.id)
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((contract) => {
        const latest = contract.versions.at(-1);
        return {
          name: contract.name,
          kind: contract.kind,
          versionCount: contract.versions.length,
          latest: latest ? summary(latest) : null,
          createdAt: contract.createdAt,
        };
      });
    return { ...this.publicService(service), contracts };
  }

  async addVersion(
    workspaceId: string,
    serviceSlug: string,
    contractName: string,
    input: NewVersion,
  ): Promise<AddVersionResult> {
    const service = this.service(workspaceId, serviceSlug);
    if (!service) throw new NotFoundError("Service");

    let contract = this.contract(service, contractName);
    if (!contract) {
      contract = {
        id: randomUUID(),
        workspaceId,
        serviceId: service.id,
        name: contractName,
        kind: input.kind,
        createdAt: this.clock(),
        versions: [],
      };
      this.contracts.push(contract);
    }
    if (contract.kind !== input.kind) throw new KindMismatchError(contractName, contract.kind, input.kind);

    const latest = contract.versions.at(-1);
    if (latest && latest.hash === input.hash) return { version: summary(latest), created: false };

    const version: VersionDetail = {
      sequence: (latest?.sequence ?? 0) + 1,
      kind: input.kind,
      declaredVersion: input.declaredVersion,
      specVersion: input.specVersion,
      hash: input.hash,
      sizeBytes: input.sizeBytes,
      source: { ...input.source },
      importedBy: input.importedBy,
      importedAt: this.clock(),
      content: input.content,
    };
    contract.versions.push(version);
    return { version: summary(version), created: true };
  }

  async listVersions(workspaceId: string, serviceSlug: string, contractName: string): Promise<VersionSummary[] | null> {
    const service = this.service(workspaceId, serviceSlug);
    const contract = service && this.contract(service, contractName);
    return contract ? [...contract.versions].reverse().map(summary) : null;
  }

  async findVersion(
    workspaceId: string,
    serviceSlug: string,
    contractName: string,
    sequence: number,
  ): Promise<VersionDetail | null> {
    const service = this.service(workspaceId, serviceSlug);
    const contract = service && this.contract(service, contractName);
    const version = contract?.versions.find((item) => item.sequence === sequence);
    return version ? { ...version, source: { ...version.source } } : null;
  }

  async putDependency(workspaceId: string, key: DependencyKey, input: NewDependency): Promise<PutDependencyResult> {
    const consumer = this.service(workspaceId, key.consumerSlug);
    if (!consumer) throw new NotFoundError("Consumer service");
    const provider = this.service(workspaceId, key.providerSlug);
    if (!provider) throw new NotFoundError("Provider service");
    if (provider.id === consumer.id) throw new SelfDependencyError(consumer.slug);
    const contract = this.contract(provider, key.contractName);
    if (!contract) throw new NotFoundError("Contract");
    if (!contract.versions.some((item) => item.sequence === input.versionSequence)) {
      throw new UnknownVersionError(contract.name, input.versionSequence);
    }

    const now = this.clock();
    const existing = this.findDependency(consumer.id, contract.id);
    const fields = {
      versionSequence: input.versionSequence,
      uses: [...input.uses],
      note: input.note,
      recordedBy: input.recordedBy,
      updatedAt: now,
    };
    if (existing) {
      Object.assign(existing, fields);
      return { dependency: this.publicDependency(existing), created: false };
    }
    const stored: StoredDependency = {
      workspaceId,
      consumerServiceId: consumer.id,
      contractId: contract.id,
      createdAt: now,
      ...fields,
    };
    this.dependencies.push(stored);
    return { dependency: this.publicDependency(stored), created: true };
  }

  async removeDependency(workspaceId: string, key: DependencyKey): Promise<boolean> {
    const consumer = this.service(workspaceId, key.consumerSlug);
    const provider = this.service(workspaceId, key.providerSlug);
    const contract = provider && this.contract(provider, key.contractName);
    if (!consumer || !contract) return false;
    const index = this.dependencies.findIndex(
      (item) => item.consumerServiceId === consumer.id && item.contractId === contract.id,
    );
    if (index < 0) return false;
    this.dependencies.splice(index, 1);
    return true;
  }

  async listDependencies(workspaceId: string, consumerSlug: string): Promise<Dependency[] | null> {
    const consumer = this.service(workspaceId, consumerSlug);
    if (!consumer) return null;
    return this.dependencies
      .filter((item) => item.workspaceId === workspaceId && item.consumerServiceId === consumer.id)
      .map((item) => this.publicDependency(item))
      .sort(byProviderThenContract);
  }

  async listConsumers(workspaceId: string, providerSlug: string, contractName: string): Promise<Dependency[] | null> {
    const provider = this.service(workspaceId, providerSlug);
    const contract = provider && this.contract(provider, contractName);
    if (!contract) return null;
    return this.dependencies
      .filter((item) => item.workspaceId === workspaceId && item.contractId === contract.id)
      .map((item) => this.publicDependency(item))
      .sort((a, b) => compare(a.consumer.slug, b.consumer.slug));
  }

  private findDependency(consumerServiceId: string, contractId: string): StoredDependency | undefined {
    return this.dependencies.find((item) => item.consumerServiceId === consumerServiceId && item.contractId === contractId);
  }

  private publicDependency(stored: StoredDependency): Dependency {
    const consumer = this.services.find((service) => service.id === stored.consumerServiceId);
    const contract = this.contracts.find((item) => item.id === stored.contractId);
    const provider = contract && this.services.find((service) => service.id === contract.serviceId);
    const version = contract?.versions.find((item) => item.sequence === stored.versionSequence);
    if (!consumer || !contract || !provider || !version) throw new Error("dangling dependency");
    return {
      consumer: { slug: consumer.slug, name: consumer.name },
      provider: { slug: provider.slug, name: provider.name },
      contract: { name: contract.name, kind: contract.kind, latestSequence: contract.versions.at(-1)?.sequence ?? 0 },
      version: { sequence: version.sequence, hash: version.hash, declaredVersion: version.declaredVersion },
      uses: [...stored.uses],
      note: stored.note,
      recordedBy: stored.recordedBy,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  private service(workspaceId: string, slug: string): StoredService | undefined {
    return this.services.find((service) => service.workspaceId === workspaceId && service.slug === slug);
  }

  private contract(service: StoredService, name: string): StoredContract | undefined {
    return this.contracts.find(
      (contract) =>
        contract.workspaceId === service.workspaceId && contract.serviceId === service.id && contract.name === name,
    );
  }

  private publicService(service: StoredService): Service {
    const { id, slug, name, description, createdAt } = service;
    return { id, slug, name, description, createdAt };
  }
}
