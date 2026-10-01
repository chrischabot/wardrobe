import { API_ERROR_STATUS, type ApiErrorCode } from "@garderobe/contracts/ext/api";
import { isCommandError } from "@garderobe/domain";

/** An error with an API error code. Nothing was written when this is thrown (unless stated in details). */
export class ApiException extends Error {
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(code: ApiErrorCode, message: string, details: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(message);
    this.name = "ApiException";
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export interface NormalizedError {
  code: ApiErrorCode;
  message: string;
  details: Record<string, unknown>;
  status: number;
  headers: Record<string, string>;
}

/** Map any thrown value to the API error shape. Unknown errors become `internal` without leaking their text. */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof ApiException) {
    return { code: error.code, message: error.message, details: error.details, status: API_ERROR_STATUS[error.code], headers: error.headers };
  }
  if (isCommandError(error)) {
    const code = error.code as ApiErrorCode;
    return { code, message: error.message, details: error.details ?? {}, status: API_ERROR_STATUS[code] ?? 500, headers: {} };
  }
  return { code: "internal", message: "an unexpected error occurred; nothing was confirmed", details: {}, status: 500, headers: {} };
}

/** Whether resubmitting the identical request later can succeed. */
export function isRetryable(code: ApiErrorCode): boolean {
  return code === "internal" || code === "rate_limited" || code === "module_unavailable";
}

export function moduleUnavailable(module: string, what: string): ApiException {
  return new ApiException("module_unavailable", `${what} is not available in this build`, { module });
}
