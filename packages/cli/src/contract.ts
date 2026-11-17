import { readFile, stat } from "node:fs/promises";

export type ContractKind = "openapi" | "json-schema";

export interface LoadedContract {
  readonly path: string;
  readonly kind: ContractKind;
  /** OpenAPI `openapi` field or JSON Schema `$schema` dialect URI. */
  readonly specVersion: string;
  /** `info.version` for OpenAPI, `version` / `x-version` for JSON Schema when present. */
  readonly contractVersion: string | undefined;
  readonly document: Record<string, unknown>;
}

export type ContractErrorCode =
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "NOT_AN_OBJECT"
  | "UNKNOWN_FORMAT"
  | "UNSUPPORTED_VERSION"
  | "MISSING_FIELD";

export class ContractError extends Error {
  constructor(
    readonly code: ContractErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ContractError";
  }
}

/** Contract files larger than this are rejected before parsing. */
export const MAX_CONTRACT_BYTES = 1024 * 1024;

const SUPPORTED_JSON_SCHEMA_DIALECTS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Classify an already-parsed document. Throws ContractError when it is not a supported contract. */
export function parseContract(path: string, text: string): LoadedContract {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ContractError("INVALID_JSON", path, `not valid JSON (${reason})`);
  }

  if (!isRecord(document)) {
    throw new ContractError("NOT_AN_OBJECT", path, "top-level value must be a JSON object");
  }

  if ("openapi" in document) {
    const specVersion = document["openapi"];
    if (typeof specVersion !== "string" || !/^3\.[01]\.\d+$/.test(specVersion)) {
      throw new ContractError(
        "UNSUPPORTED_VERSION",
        path,
        `unsupported OpenAPI version ${JSON.stringify(specVersion)} (expected 3.0.x or 3.1.x)`,
      );
    }
    const info = document["info"];
    if (!isRecord(info) || typeof info["version"] !== "string") {
      throw new ContractError("MISSING_FIELD", path, "OpenAPI document needs info.version");
    }
    if (!isRecord(document["paths"])) {
      throw new ContractError("MISSING_FIELD", path, "OpenAPI document needs a paths object");
    }
    return { path, kind: "openapi", specVersion, contractVersion: info["version"], document };
  }

  if ("$schema" in document) {
    const dialect = document["$schema"];
    if (typeof dialect !== "string" || !SUPPORTED_JSON_SCHEMA_DIALECTS.has(dialect)) {
      throw new ContractError(
        "UNSUPPORTED_VERSION",
        path,
        `unsupported JSON Schema dialect ${JSON.stringify(dialect)}`,
      );
    }
    if (typeof document["type"] !== "string" && !isRecord(document["properties"])) {
      throw new ContractError("MISSING_FIELD", path, "JSON Schema needs a type or properties");
    }
    const declared = document["version"] ?? document["x-version"];
    return {
      path,
      kind: "json-schema",
      specVersion: dialect,
      contractVersion: typeof declared === "string" ? declared : undefined,
      document,
    };
  }

  throw new ContractError(
    "UNKNOWN_FORMAT",
    path,
    "not an OpenAPI document (no `openapi` field) or JSON Schema (no `$schema` field)",
  );
}

/** Read a local contract file. Never fetches anything over the network. */
export async function loadContract(path: string): Promise<LoadedContract> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new ContractError("NOT_FOUND", path, "file not found");
  }
  if (size > MAX_CONTRACT_BYTES) {
    throw new ContractError("TOO_LARGE", path, `file is ${size} bytes (limit ${MAX_CONTRACT_BYTES})`);
  }
  return parseContract(path, await readFile(path, "utf8"));
}
