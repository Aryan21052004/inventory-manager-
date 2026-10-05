/**
 * Application error types and the one place raw thrown values get turned into
 * something safe to show a user.
 *
 * The rule this file exists to enforce: a message only reaches the UI if we
 * wrote it. Anything else — a Prisma error naming a column, a driver error
 * naming a host and port — is logged server-side and replaced with a generic
 * line, so internal detail never leaks into the browser.
 */

export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_STOCK"
  | "RATE_LIMITED"
  | "DATABASE_UNAVAILABLE"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INSUFFICIENT_STOCK: 422,
  RATE_LIMITED: 429,
  DATABASE_UNAVAILABLE: 503,
  /** A dependency other than the database — the assistant's AI provider. */
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** The HTTP status a route handler should answer with for an error code. */
export function httpStatusFor(code: AppErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * An error whose message is deliberately safe to display. Throw this from
 * server actions and route handlers when the user can act on what went wrong.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super("NOT_FOUND", `${resource} could not be found.`);
    this.name = "NotFoundError";
  }
}

/**
 * Raised when an order would take stock below zero. The available quantity is
 * carried on the error so the UI can say how many are actually on hand rather
 * than just refusing.
 */
export class InsufficientStockError extends AppError {
  constructor(productName: string, requested: number, available: number) {
    super(
      "INSUFFICIENT_STOCK",
      `Not enough stock for ${productName}: ${requested} requested, ${available} available.`,
      { productName, requested, available },
    );
    this.name = "InsufficientStockError";
  }
}

const GENERIC_MESSAGE =
  "Something went wrong on our end. Please try again in a moment.";

export interface SafeError {
  code: AppErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Normalise any thrown value into something the UI can render.
 *
 * `AppError` messages are written by us and pass through as-is. Everything else
 * is logged with its stack and reported generically — the user gets a sentence
 * they can act on, and the detail stays in the server logs where it belongs.
 */
export function toSafeError(error: unknown, context?: string): SafeError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }

  console.error(
    `[inventory-manager]${context ? ` ${context}:` : ""}`,
    error instanceof Error ? error.stack ?? error.message : error,
  );

  if (isDatabaseConnectionError(error)) {
    return {
      code: "DATABASE_UNAVAILABLE",
      message:
        "The database is not reachable right now. Check the connection and try again.",
    };
  }

  return { code: "INTERNAL", message: GENERIC_MESSAGE };
}

/**
 * Prisma's connection-level error codes. These mean the query never reached a
 * working database, as opposed to a query that ran and failed.
 *
 * P1000 authentication failed        P1001 cannot reach server
 * P1002 connection timed out         P1003 database does not exist
 * P1010 access denied                P1017 server closed the connection
 */
const DB_CONNECTION_CODES = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1003",
  "P1010",
  "P1017",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

/**
 * Connection-level failures are worth telling apart from ordinary bugs: in
 * development they almost always mean Postgres is not running, the credentials
 * are wrong, or the migration has not been applied. Saying "the database is not
 * reachable" instead of "something went wrong" saves a debugging session.
 */
function isDatabaseConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && DB_CONNECTION_CODES.has(code)) {
    return true;
  }

  // The adapter surfaces some failures as plain errors with no code.
  return /can't reach database server|connection refused|connection terminated|authentication failed|server has closed the connection|does not exist on the database/i.test(
    error.message,
  );
}
