export class HttpError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = null, param = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

export class AuthError extends Error {
  constructor(message = 'DeepSeek token is missing or invalid') {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
    this.type = 'authentication_error';
    this.code = 'invalid_token';
  }
}

export class UpstreamError extends Error {
  constructor(message, { status = 502, code = null, type = 'upstream_error', retryable = false } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.retryable = retryable;
  }
}

export function isPowError(code) {
  return [40300, 40301, 40303, 40304].includes(Number(code));
}
