import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import {
  ContractError,
  MAX_CONTRACT_BYTES,
  getAtPointer,
  parseContract,
  type LoadedContract,
} from "@contractpulse/cli";
import type { Caller, DependencyKey, NewVersion, VersionDetail, VersionSummary } from "./domain.js";
import { HttpError, KindMismatchError, NotFoundError, SelfDependencyError, UnknownVersionError } from "./errors.js";
import { computeImpact, type PinnedConsumer } from "./impact.js";
import type { RegistryStore } from "./store.js";
import { hashToken } from "./tokens.js";

export interface AppOptions {
  store: RegistryStore;
  logger?: boolean;
}

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, "2-64 lowercase letters, digits or dashes; no leading/trailing dash");
/** Contract names may contain dots, e.g. `orders.created`. */
const contractName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,98}[a-z0-9]$/,
    "2-100 lowercase letters, digits, dots, dashes or underscores; must start and end with a letter or digit",
  );

const workspaceParams = z.object({ workspace: slug });
const serviceParams = workspaceParams.extend({ service: slug });
const contractParams = serviceParams.extend({ contract: contractName });
const versionParams = contractParams.extend({
  sequence: z.coerce.number().int().min(1).max(2_147_483_647),
});

const dependencyParams = serviceParams.extend({ provider: slug, contract: contractName });

/** RFC 6901 JSON Pointer to something inside the document (not the root itself). */
const jsonPointer = z
  .string()
  .max(500)
  .regex(/^(\/([^~/]|~[01])*)+$/, "must be a JSON Pointer such as /properties/orderId");

const putDependencyBody = z
  .object({
    /** The provider's contract version the consumer was built and tested against. */
    version: z.number().int().min(1).max(2_147_483_647),
    /** Parts of that version the consumer relies on; omitted or empty means the whole contract. */
    uses: z.array(jsonPointer).max(200).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/** Said with every consumer list so a short list isn't read as "nobody else uses this". */
const CONSUMER_COVERAGE =
  "Only consumers registered in this workspace are listed; unregistered clients of this contract are not known.";

const impactQuery = z
  .object({ version: z.coerce.number().int().min(1).max(2_147_483_647).optional() })
  .strict();

const createServiceBody = z
  .object({
    slug,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
  })
  .strict();

const importVersionBody = z
  .object({
    /** The contract file's text, exactly as stored in the repository. */
    content: z.string().min(1),
    source: z
      .object({
        path: z.string().trim().min(1).max(500),
        repository: z.string().trim().min(1).max(300).optional(),
        ref: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict();

/** JSON string escaping can grow the body well past the file size; the file limit is checked separately. */
const BODY_LIMIT = MAX_CONTRACT_BYTES * 2 + 64 * 1024;

/** Parse an uploaded contract file with the CLI's bounded parser; 413/422 when it can't be accepted. */
function parseUpload(content: string, path: string): { parsed: LoadedContract; sizeBytes: number } {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_CONTRACT_BYTES) {
    throw new HttpError(413, "TOO_LARGE", `Contract is ${sizeBytes} bytes (limit ${MAX_CONTRACT_BYTES})`);
  }
  try {
    return { parsed: parseContract(path, content), sizeBytes };
  } catch (error) {
    if (error instanceof ContractError) {
      throw new HttpError(422, "INVALID_CONTRACT", error.message, { reason: error.code });
    }
    throw error;
  }
}

/** Stored versions were accepted by the same parser when imported. */
const parseStored = (version: VersionDetail): LoadedContract => parseContract(version.source.path, version.content);

function envelope(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { store } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: BODY_LIMIT });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send(envelope(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      const message = error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return reply.status(400).send(envelope("BAD_REQUEST", message));
    }
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      // Fastify's own client errors: malformed JSON, wrong content type, body too large.
      const code = status === 413 ? "TOO_LARGE" : "BAD_REQUEST";
      return reply.status(status).send(envelope(code, (error as Error).message));
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(envelope("INTERNAL", "Internal server error"));
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send(envelope("NOT_FOUND", "Route not found")));

  /**
   * Resolve the bearer token and check it belongs to the workspace in the URL.
   * A token for another workspace gets 404, not 403, so slugs don't leak across tenants.
   */
  async function authorize(request: FastifyRequest, workspaceSlug: string): Promise<Caller> {
    const header = request.headers.authorization;
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) throw new HttpError(401, "UNAUTHENTICATED", "Missing bearer token");
    const caller = await store.findCaller(hashToken(match[1]));
    if (!caller) throw new HttpError(401, "UNAUTHENTICATED", "Unknown or revoked token");
    if (caller.workspace.slug !== workspaceSlug) throw new NotFoundError("Workspace");
    return caller;
  }

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/workspaces/:workspace", async (request) => {
    const params = workspaceParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    return { workspace };
  });

  app.get("/v1/workspaces/:workspace/services", async (request) => {
    const params = workspaceParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    return { services: await store.listServices(workspace.id) };
  });

  app.post("/v1/workspaces/:workspace/services", async (request, reply) => {
    const params = workspaceParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const body = createServiceBody.parse(request.body);
    const service = await store.createService(workspace.id, {
      slug: body.slug,
      name: body.name,
      description: body.description || null,
    });
    return reply.status(201).send({ service });
  });

  app.get("/v1/workspaces/:workspace/services/:service", async (request) => {
    const params = serviceParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const service = await store.findService(workspace.id, params.service);
    if (!service) throw new NotFoundError("Service");
    return { service };
  });

  /**
   * Import a contract file as the next version. The file goes through the same
   * bounded parser as the CLI; re-importing content equal to the latest version
   * (same canonical hash) returns that version with 200 instead of adding one.
   */
  app.post("/v1/workspaces/:workspace/services/:service/contracts/:contract/versions", async (request, reply) => {
    const params = contractParams.parse(request.params);
    const caller = await authorize(request, params.workspace);
    const body = importVersionBody.parse(request.body);

    const { parsed, sizeBytes } = parseUpload(body.content, body.source.path);

    const input: NewVersion = {
      kind: parsed.kind,
      declaredVersion: parsed.contractVersion ?? null,
      specVersion: parsed.specVersion,
      hash: parsed.hash,
      sizeBytes,
      content: body.content,
      source: { path: body.source.path, repository: body.source.repository ?? null, ref: body.source.ref ?? null },
      importedBy: caller.tokenLabel,
    };
    const result = await store.addVersion(caller.workspace.id, params.service, params.contract, input);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.get("/v1/workspaces/:workspace/services/:service/contracts/:contract/versions", async (request) => {
    const params = contractParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const versions = await store.listVersions(workspace.id, params.service, params.contract);
    if (!versions) throw new NotFoundError("Contract");
    return { versions };
  });

  app.get("/v1/workspaces/:workspace/services/:service/contracts/:contract/versions/:sequence", async (request) => {
    const params = versionParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const version = await store.findVersion(workspace.id, params.service, params.contract, params.sequence);
    if (!version) throw new NotFoundError("Contract version");
    return { version };
  });

  /**
   * Register (or replace) the service's dependency on another service's
   * contract. Every pointer in `uses` must exist in the pinned version, so a
   * typo can't silently hide the consumer from impact reports later.
   */
  app.put("/v1/workspaces/:workspace/services/:service/dependencies/:provider/:contract", async (request, reply) => {
    const params = dependencyParams.parse(request.params);
    const caller = await authorize(request, params.workspace);
    const body = putDependencyBody.parse(request.body);
    const workspaceId = caller.workspace.id;

    if (!(await store.findService(workspaceId, params.service))) throw new NotFoundError("Consumer service");
    if (params.provider === params.service) throw new SelfDependencyError(params.service);
    const version = await store.findVersion(workspaceId, params.provider, params.contract, body.version);
    if (!version) {
      if (!(await store.listVersions(workspaceId, params.provider, params.contract))) throw new NotFoundError("Contract");
      throw new UnknownVersionError(params.contract, body.version);
    }

    const uses = [...new Set(body.uses ?? [])].sort();
    if (uses.length > 0) {
      const { document } = parseStored(version);
      const missing = uses.filter((pointer) => getAtPointer(document, pointer) === undefined);
      if (missing.length > 0) {
        throw new HttpError(
          422,
          "UNKNOWN_POINTER",
          `Version ${body.version} of "${params.contract}" has nothing at ${missing.join(", ")}`,
          { pointers: missing },
        );
      }
    }

    const key: DependencyKey = {
      consumerSlug: params.service,
      providerSlug: params.provider,
      contractName: params.contract,
    };
    const result = await store.putDependency(workspaceId, key, {
      versionSequence: body.version,
      uses,
      note: body.note || null,
      recordedBy: caller.tokenLabel,
    });
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.delete("/v1/workspaces/:workspace/services/:service/dependencies/:provider/:contract", async (request, reply) => {
    const params = dependencyParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const removed = await store.removeDependency(workspace.id, {
      consumerSlug: params.service,
      providerSlug: params.provider,
      contractName: params.contract,
    });
    if (!removed) throw new NotFoundError("Dependency");
    return reply.status(204).send();
  });

  app.get("/v1/workspaces/:workspace/services/:service/dependencies", async (request) => {
    const params = serviceParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const dependencies = await store.listDependencies(workspace.id, params.service);
    if (!dependencies) throw new NotFoundError("Service");
    return { dependencies };
  });

  app.get("/v1/workspaces/:workspace/services/:service/contracts/:contract/consumers", async (request) => {
    const params = contractParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const consumers = await store.listConsumers(workspace.id, params.service, params.contract);
    if (!consumers) throw new NotFoundError("Contract");
    return { consumers, coverage: CONSUMER_COVERAGE };
  });

  /**
   * Compare `target` with the version each registered consumer is pinned to.
   * Pinned versions are read and parsed once each, however many consumers share them.
   */
  async function impactOf(workspaceId: string, providerSlug: string, contractName: string, target: LoadedContract) {
    const consumers = await store.listConsumers(workspaceId, providerSlug, contractName);
    if (!consumers) throw new NotFoundError("Contract");

    const parsed = new Map<number, LoadedContract>();
    const pinned: PinnedConsumer[] = [];
    for (const dependency of consumers) {
      const sequence = dependency.version.sequence;
      let contract = parsed.get(sequence);
      if (!contract) {
        const version = await store.findVersion(workspaceId, providerSlug, contractName, sequence);
        if (!version) throw new Error(`pinned version ${sequence} of ${contractName} disappeared`);
        contract = parseStored(version);
        parsed.set(sequence, contract);
      }
      pinned.push({ dependency, pinned: contract });
    }
    return { ...computeImpact(target, pinned), coverage: CONSUMER_COVERAGE };
  }

  /** Impact of a stored version (default: the latest) on every registered consumer. */
  app.get("/v1/workspaces/:workspace/services/:service/contracts/:contract/impact", async (request) => {
    const params = contractParams.parse(request.params);
    const query = impactQuery.parse(request.query);
    const { workspace } = await authorize(request, params.workspace);

    const versions = await store.listVersions(workspace.id, params.service, params.contract);
    if (!versions) throw new NotFoundError("Contract");
    const sequence = query.version ?? versions[0]?.sequence;
    const version =
      sequence === undefined ? null : await store.findVersion(workspace.id, params.service, params.contract, sequence);
    if (!version) throw new NotFoundError("Contract version");

    const target = parseStored(version);
    // The file itself is available from the version endpoint; the report only names it.
    const summary: VersionSummary = {
      sequence: version.sequence,
      kind: version.kind,
      declaredVersion: version.declaredVersion,
      specVersion: version.specVersion,
      hash: version.hash,
      sizeBytes: version.sizeBytes,
      source: version.source,
      importedBy: version.importedBy,
      importedAt: version.importedAt,
    };
    return {
      target: { stored: true, version: summary },
      ...(await impactOf(workspace.id, params.service, params.contract, target)),
    };
  });

  /**
   * Impact of a contract file that hasn't been imported, e.g. the file on a
   * pull request branch. Nothing is stored.
   */
  app.post("/v1/workspaces/:workspace/services/:service/contracts/:contract/impact", async (request) => {
    const params = contractParams.parse(request.params);
    const { workspace } = await authorize(request, params.workspace);
    const body = importVersionBody.parse(request.body);
    const { parsed, sizeBytes } = parseUpload(body.content, body.source.path);

    const versions = await store.listVersions(workspace.id, params.service, params.contract);
    if (!versions) throw new NotFoundError("Contract");
    const kind = versions[0]?.kind;
    if (kind !== undefined && kind !== parsed.kind) throw new KindMismatchError(params.contract, kind, parsed.kind);

    const latest = versions[0];
    return {
      target: {
        stored: false,
        candidate: {
          kind: parsed.kind,
          declaredVersion: parsed.contractVersion ?? null,
          specVersion: parsed.specVersion,
          hash: parsed.hash,
          sizeBytes,
          source: { path: body.source.path, repository: body.source.repository ?? null, ref: body.source.ref ?? null },
          // Sequence of the latest stored version when it has the same canonical content.
          matchesLatest: latest !== undefined && latest.hash === parsed.hash ? latest.sequence : null,
        },
      },
      ...(await impactOf(workspace.id, params.service, params.contract, parsed)),
    };
  });

  return app;
}
