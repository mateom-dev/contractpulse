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
