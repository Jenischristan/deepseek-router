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
  constructor(
    message,
    { status = 502, code = null, type = 'upstream_error', retryable = false, retryAfterMs = null } = {},
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// DeepSeek uses this for an account that has to be verified interactively in
// the browser (captcha / challenge). It is not a transient upstream failure:
// retrying it only burns the account, so callers must stop using the token.
export class ChallengeError extends UpstreamError {
  constructor(message = 'DeepSeek requires manual verification for this account') {
    super(message, {
      status: 403,
      code: 'challenge_required',
      type: 'permission_error',
      retryable: false,
    });
    this.name = 'ChallengeError';
  }
}

const CHALLENGE_PATTERN =
  /(?:challenge[_ -]?required|captcha|verification[_ -]?required|verify (?:your )?(?:account|identity|human))/i;

export function isChallengeMessage(value) {
  return typeof value === 'string' && CHALLENGE_PATTERN.test(value);
}

export function isPowError(code) {
  return [40300, 40301, 40303, 40304].includes(Number(code));
}
