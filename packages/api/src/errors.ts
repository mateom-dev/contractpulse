export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class NotFoundError extends HttpError {
  constructor(what: string) {
    super(404, "NOT_FOUND", `${what} not found`);
  }
}

export class SlugTakenError extends HttpError {
  constructor(slug: string) {
    super(409, "SLUG_TAKEN", `A service with slug "${slug}" already exists in this workspace`);
  }
}

export class KindMismatchError extends HttpError {
  constructor(contract: string, expected: string, actual: string) {
    super(409, "KIND_MISMATCH", `Contract "${contract}" holds ${expected} documents; this file is ${actual}`, {
      expected,
      actual,
    });
  }
}

export class SelfDependencyError extends HttpError {
  constructor(service: string) {
    super(422, "SELF_DEPENDENCY", `Service "${service}" can't be registered as a consumer of its own contract`);
  }
}

export class UnknownVersionError extends HttpError {
  constructor(contract: string, sequence: number) {
    super(422, "UNKNOWN_VERSION", `Contract "${contract}" has no version ${sequence}`, { sequence });
  }
}
