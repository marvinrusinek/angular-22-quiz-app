/**
 * Error vocabulary + the single public error shape.
 *
 * Messages here are written to be safe to return to a client verbatim. Anything
 * sensitive (session tokens, file paths, the answer key, stack traces) must
 * never reach an ApiError message — the handler in `error-handler.ts` replaces
 * unexpected errors with a generic message rather than trusting callers.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GONE'
  | 'SESSION_EXPIRED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  SESSION_EXPIRED: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500
};

/** The ONLY body shape any error response ever takes. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

export class ApiError extends Error {
  public override readonly name = 'ApiError';
  public readonly code: ErrorCode;
  public readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }

  static badRequest(message: string): ApiError {
    return new ApiError('BAD_REQUEST', message);
  }
  static unauthorized(message = 'Missing or invalid session token'): ApiError {
    return new ApiError('UNAUTHORIZED', message);
  }
  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError('NOT_FOUND', message);
  }
  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', message);
  }
  static sessionExpired(message = 'This assessment has expired'): ApiError {
    return new ApiError('SESSION_EXPIRED', message);
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
