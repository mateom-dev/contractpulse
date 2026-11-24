import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { ContractError, MAX_CONTRACT_BYTES, parseContract } from "@contractpulse/cli";
import type { Caller, NewVersion } from "./domain.js";
import { HttpError, NotFoundError } from "./errors.js";
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

    const sizeBytes = Buffer.byteLength(body.content, "utf8");
    if (sizeBytes > MAX_CONTRACT_BYTES) {
      throw new HttpError(413, "TOO_LARGE", `Contract is ${sizeBytes} bytes (limit ${MAX_CONTRACT_BYTES})`);
    }

    let parsed;
    try {
      parsed = parseContract(body.source.path, body.content);
    } catch (error) {
      if (error instanceof ContractError) {
        throw new HttpError(422, "INVALID_CONTRACT", error.message, { reason: error.code });
      }
      throw error;
    }

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

  return app;
}
