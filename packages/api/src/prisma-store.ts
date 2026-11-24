import { Prisma, type PrismaClient } from "@prisma/client";
import type { ContractKind } from "@contractpulse/cli";
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
import { KindMismatchError, NotFoundError, SlugTakenError } from "./errors.js";
import type { RegistryStore } from "./store.js";

type VersionRow = Prisma.ContractVersionGetPayload<object>;

const summarySelect = {
  sequence: true,
  kind: true,
  declaredVersion: true,
  specVersion: true,
  hash: true,
  sizeBytes: true,
  sourcePath: true,
  sourceRepository: true,
  sourceRef: true,
  importedBy: true,
  importedAt: true,
} satisfies Prisma.ContractVersionSelect;

type SummaryRow = Pick<VersionRow, keyof typeof summarySelect>;

function toKind(kind: string): ContractKind {
  if (kind === "openapi" || kind === "json-schema") return kind;
  throw new Error(`unexpected contract kind ${kind}`);
}

function toSummary(row: SummaryRow): VersionSummary {
  return {
    sequence: row.sequence,
    kind: toKind(row.kind),
    declaredVersion: row.declaredVersion,
    specVersion: row.specVersion,
    hash: row.hash,
    sizeBytes: row.sizeBytes,
    source: { path: row.sourcePath, repository: row.sourceRepository, ref: row.sourceRef },
    importedBy: row.importedBy,
    importedAt: row.importedAt,
  };
}

function toService(row: { id: string; slug: string; name: string; description: string | null; createdAt: Date }): Service {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description, createdAt: row.createdAt };
}

/** PostgreSQL RegistryStore. Every query filters on the caller's workspace id. */
export class PrismaRegistryStore implements RegistryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findCaller(tokenHash: string): Promise<Caller | null> {
    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash },
      include: { workspace: true },
    });
    if (!token || token.revokedAt !== null) return null;
    const { id, slug, name } = token.workspace;
    return { workspace: { id, slug, name }, tokenLabel: token.label };
  }

  async listServices(workspaceId: string): Promise<ServiceSummary[]> {
    const rows = await this.prisma.service.findMany({
      where: { workspaceId },
      orderBy: { slug: "asc" },
      include: { _count: { select: { contracts: true } } },
    });
    return rows.map((row) => ({ ...toService(row), contractCount: row._count.contracts }));
  }

  async createService(workspaceId: string, input: NewService): Promise<Service> {
    try {
      return toService(await this.prisma.service.create({ data: { workspaceId, ...input } }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new SlugTakenError(input.slug);
      }
      throw error;
    }
  }

  async findService(workspaceId: string, serviceSlug: string): Promise<ServiceDetail | null> {
    const row = await this.prisma.service.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: serviceSlug } },
      include: {
        contracts: {
          where: { workspaceId },
          orderBy: { name: "asc" },
          include: {
            _count: { select: { versions: true } },
            versions: { orderBy: { sequence: "desc" }, take: 1, select: summarySelect },
          },
        },
      },
    });
    if (!row) return null;
    return {
      ...toService(row),
      contracts: row.contracts.map((contract) => {
        const latest = contract.versions[0];
        return {
          name: contract.name,
          kind: toKind(contract.kind),
          versionCount: contract._count.versions,
          latest: latest ? toSummary(latest) : null,
          createdAt: contract.createdAt,
        };
      }),
    };
  }

  async addVersion(
    workspaceId: string,
    serviceSlug: string,
    contractName: string,
    input: NewVersion,
  ): Promise<AddVersionResult> {
    return this.prisma.$transaction(async (tx) => {
      const service = await tx.service.findUnique({
        where: { workspaceId_slug: { workspaceId, slug: serviceSlug } },
        select: { id: true },
      });
      if (!service) throw new NotFoundError("Service");

      const contract = await tx.contract.upsert({
        where: { serviceId_name: { serviceId: service.id, name: contractName } },
        create: { workspaceId, serviceId: service.id, name: contractName, kind: input.kind },
        update: {},
      });
      if (contract.kind !== input.kind) throw new KindMismatchError(contractName, contract.kind, input.kind);

      // Serialize imports per contract so sequence numbers never collide.
      await tx.$queryRaw`SELECT id FROM contracts WHERE id = ${contract.id}::uuid FOR UPDATE`;

      const latest = await tx.contractVersion.findFirst({
        where: { workspaceId, contractId: contract.id },
        orderBy: { sequence: "desc" },
        select: summarySelect,
      });
      if (latest && latest.hash === input.hash) return { version: toSummary(latest), created: false };

      const created = await tx.contractVersion.create({
        data: {
          workspaceId,
          contractId: contract.id,
          sequence: (latest?.sequence ?? 0) + 1,
          kind: input.kind,
          declaredVersion: input.declaredVersion,
          specVersion: input.specVersion,
          hash: input.hash,
          sizeBytes: input.sizeBytes,
          content: input.content,
          sourcePath: input.source.path,
          sourceRepository: input.source.repository,
          sourceRef: input.source.ref,
          importedBy: input.importedBy,
        },
        select: summarySelect,
      });
      return { version: toSummary(created), created: true };
    });
  }

  async listVersions(workspaceId: string, serviceSlug: string, contractName: string): Promise<VersionSummary[] | null> {
    const contract = await this.findContract(workspaceId, serviceSlug, contractName);
    if (!contract) return null;
    const rows = await this.prisma.contractVersion.findMany({
      where: { workspaceId, contractId: contract.id },
      orderBy: { sequence: "desc" },
      select: summarySelect,
    });
    return rows.map(toSummary);
  }

  async findVersion(
    workspaceId: string,
    serviceSlug: string,
    contractName: string,
    sequence: number,
  ): Promise<VersionDetail | null> {
    const contract = await this.findContract(workspaceId, serviceSlug, contractName);
    if (!contract) return null;
    const row = await this.prisma.contractVersion.findFirst({
      where: { workspaceId, contractId: contract.id, sequence },
      select: { ...summarySelect, content: true },
    });
    return row ? { ...toSummary(row), content: row.content } : null;
  }

  private findContract(workspaceId: string, serviceSlug: string, contractName: string) {
    return this.prisma.contract.findFirst({
      where: { workspaceId, name: contractName, service: { workspaceId, slug: serviceSlug } },
      select: { id: true },
    });
  }
}
