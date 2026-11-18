/**
 * Local `$ref` resolution with a hop limit and cycle detection.
 * Nothing is ever fetched: references that leave the document are recorded as
 * `remote` so the rules can report them as UNKNOWN.
 */
import { DEFAULT_LIMITS, escapePointerToken, unescapePointerToken } from "./bounds.js";

export type RefStatus =
  /** Points inside this document and the target exists. */
  | "local"
  /** Points to another file or URL; never fetched. */
  | "remote"
  /** Points inside this document but the target does not exist. */
  | "missing"
  /** Following the chain comes back to a reference already visited. */
  | "cycle"
  /** The chain is longer than `maxRefHops`. */
  | "too-deep";

export interface ContractReference {
  /** JSON Pointer of the object holding the `$ref`. */
  readonly at: string;
  readonly ref: string;
  readonly status: RefStatus;
  /** Pointer of the final, non-`$ref` target when status is `local`. */
  readonly target?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Look up a JSON Pointer (`""` or `/a/b`). Returns `undefined` when any step is missing. */
export function getAtPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = unescapePointerToken(raw);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** `#/components/schemas/Order` → `/components/schemas/Order`; `undefined` for non-local refs. */
export function localPointer(ref: string): string | undefined {
  if (!ref.startsWith("#")) return undefined;
  try {
    return decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
}

/** Follow one `$ref` (and any `$ref` it lands on) up to `maxRefHops`. */
export function resolveRef(
  document: unknown,
  ref: string,
  maxRefHops: number = DEFAULT_LIMITS.maxRefHops,
): { status: RefStatus; target?: string } {
  const seen = new Set<string>();
  let current = ref;
  for (let hop = 0; hop <= maxRefHops; hop += 1) {
    const pointer = localPointer(current);
    if (pointer === undefined) return { status: "remote" };
    if (seen.has(pointer)) return { status: "cycle" };
    seen.add(pointer);

    const value = getAtPointer(document, pointer);
    if (value === undefined) return { status: "missing" };
    if (isRecord(value) && typeof value["$ref"] === "string") {
      current = value["$ref"];
      continue;
    }
    return { status: "local", target: pointer };
  }
  return { status: "too-deep" };
}

/** Find every `$ref` in the document, in document order, and resolve each one. */
export function collectReferences(
  document: unknown,
  maxRefHops: number = DEFAULT_LIMITS.maxRefHops,
): ContractReference[] {
  const found: ContractReference[] = [];
  const stack: Array<{ value: unknown; pointer: string }> = [{ value: document, pointer: "" }];

  while (stack.length > 0) {
    const { value, pointer } = stack.pop()!;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push({ value: value[i], pointer: `${pointer}/${i}` });
      continue;
    }
    if (!isRecord(value)) continue;

    const ref = value["$ref"];
    if (typeof ref === "string") {
      const resolved = resolveRef(document, ref, maxRefHops);
      found.push(
        resolved.target === undefined
          ? { at: pointer, ref, status: resolved.status }
          : { at: pointer, ref, status: resolved.status, target: resolved.target },
      );
    }
    const entries = Object.entries(value);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [key, item] = entries[i]!;
      stack.push({ value: item, pointer: `${pointer}/${escapePointerToken(key)}` });
    }
  }
  return found;
}
