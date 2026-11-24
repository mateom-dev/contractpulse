import { randomUUID } from "node:crypto";
import type { ContractKind } from "@contractpulse/cli";
import type {
  AddVersionResult,
  Caller,
  ContractSummary,
  NewService,
  NewVersion,
  Service,
  ServiceDetail,
  ServiceSummary,
  VersionDetail,
  VersionSummary,
  Workspace,
} from "./domain.js";
import { KindMismatchError, NotFoundError, SlugTakenError } from "./errors.js";
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
  private readonly tokens = new Map<string, { workspaceId: string; label: string }>();
  private readonly services: StoredService[] = [];
  private readonly contracts: StoredContract[] = [];
  private clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  addWorkspace(slug: string, name: string): Workspace {
    const workspace = { id: randomUUID(), slug, name };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  addToken(workspaceId: string, token: string, label: string): void {
    this.tokens.set(hashToken(token), { workspaceId, label });
  }

  async findCaller(tokenHash: string): Promise<Caller | null> {
    const token = this.tokens.get(tokenHash);
    const workspace = token && this.workspaces.get(token.workspaceId);
    return token && workspace ? { workspace: { ...workspace }, tokenLabel: token.label } : null;
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
