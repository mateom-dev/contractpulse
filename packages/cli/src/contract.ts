import { readFile, stat } from "node:fs/promises";
import {
  DEFAULT_LIMITS,
  LimitExceededError,
  checkDocumentBounds,
  checkTextDepth,
  type ParseLimits,
} from "./engine/bounds.js";
import { collectReferences, type ContractReference } from "./engine/refs.js";

export type ContractKind = "openapi" | "json-schema";

export interface LoadedContract {
  readonly path: string;
  readonly kind: ContractKind;
  /** OpenAPI `openapi` field or JSON Schema `$schema` dialect URI. */
  readonly specVersion: string;
  /** `info.version` for OpenAPI, `version` / `x-version` for JSON Schema when present. */
  readonly contractVersion: string | undefined;
  readonly document: Record<string, unknown>;
  /** Every `$ref` in the document. Remote ones are listed, never fetched. */
  readonly references: readonly ContractReference[];
}

export type ContractErrorCode =
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "NOT_AN_OBJECT"
  | "UNKNOWN_FORMAT"
  | "UNSUPPORTED_VERSION"
  | "MISSING_FIELD"
  | "LIMIT_EXCEEDED"
  | "BROKEN_REF";

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

/**
 * Parse and classify contract text within `limits`. Throws ContractError when the
 * text is not a supported contract, exceeds a limit, or has a dangling local `$ref`.
 */
export function parseContract(path: string, text: string, limits: ParseLimits = DEFAULT_LIMITS): LoadedContract {
  let document: unknown;
  try {
    checkTextDepth(text, limits.maxDepth);
    document = JSON.parse(text);
    checkDocumentBounds(document, limits);
  } catch (error) {
    if (error instanceof LimitExceededError) {
      throw new ContractError("LIMIT_EXCEEDED", path, error.message);
    }
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
    return {
      path,
      kind: "openapi",
      specVersion,
      contractVersion: info["version"],
      document,
      references: checkedReferences(path, document, limits),
    };
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
      references: checkedReferences(path, document, limits),
    };
  }

  throw new ContractError(
    "UNKNOWN_FORMAT",
    path,
    "not an OpenAPI document (no `openapi` field) or JSON Schema (no `$schema` field)",
  );
}

function checkedReferences(
  path: string,
  document: Record<string, unknown>,
  limits: ParseLimits,
): ContractReference[] {
  const references = collectReferences(document, limits.maxRefHops);
  const broken = references.find((reference) => reference.status === "missing");
  if (broken !== undefined) {
    throw new ContractError(
      "BROKEN_REF",
      path,
      `$ref ${JSON.stringify(broken.ref)} at ${broken.at || "/"} points to nothing in this document`,
    );
  }
  return references;
}

/** Read a local contract file. Never fetches anything over the network. */
export async function loadContract(path: string, limits: ParseLimits = DEFAULT_LIMITS): Promise<LoadedContract> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new ContractError("NOT_FOUND", path, "file not found");
  }
  if (size > MAX_CONTRACT_BYTES) {
    throw new ContractError("TOO_LARGE", path, `file is ${size} bytes (limit ${MAX_CONTRACT_BYTES})`);
  }
  return parseContract(path, await readFile(path, "utf8"), limits);
}
