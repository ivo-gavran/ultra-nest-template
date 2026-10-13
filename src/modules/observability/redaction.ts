// Error output allowlist shared by logs, Sentry events and span exceptions.
// Error objects are never serialized wholesale: own properties such as
// DrizzleQueryError.query/params, causes' details or request data stay out.

const MAX_MESSAGE_LENGTH = 200;
const MAX_FRAMES = 20;
const MAX_FRAME_LENGTH = 300;
const MAX_CAUSE_DEPTH = 2;

// Free-text messages can embed data (Drizzle appends bound parameters on the
// second line, pg and V8 quote offending input). Keep the first line only and
// mask values that commonly carry credentials, identifiers or addresses.
const MASKS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  /\beyJ[\w-]*\.[\w-]*\.[\w-]*/g,
  /[^\s@'"`<>(),;:]+@[^\s@'"`<>(),;:]+/g,
  /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g,
  /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}(?![\w:])/gi,
  /(?=[\w+/=-]*\d)[\w+/=-]{24,}/g,
];

export function sanitizeErrorMessage(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  let text = message.split(/\r?\n/, 1)[0].slice(0, 2_000);
  for (const mask of MASKS) text = text.replace(mask, '[redacted]');
  text = text.trim();
  if (!text) return undefined;
  return text.length > MAX_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
    : text;
}

export function errorType(error: unknown): string {
  const name =
    error instanceof Error
      ? error.name !== 'Error'
        ? error.name
        : error.constructor.name
      : undefined;
  return typeof name === 'string' && /^[A-Za-z_$][\w$.]{0,63}$/.test(name)
    ? name
    : 'Error';
}

// SQLSTATE (e.g. 23505) and Node system codes (e.g. ECONNREFUSED).
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)
    ? code
    : undefined;
}

export function stackFrames(stack: unknown): string[] | undefined {
  if (typeof stack !== 'string') return undefined;
  const frames = stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim().slice(0, MAX_FRAME_LENGTH));
  return frames.length > 0 ? frames : undefined;
}

export interface SafeError {
  type: string;
  code?: string;
  message?: string;
  stack?: string[];
  cause?: SafeError;
}

export function serializeError(error: unknown, depth = 0): SafeError {
  const safe: SafeError = { type: errorType(error) };
  const code = errorCode(error);
  if (code) safe.code = code;
  if (error instanceof Error) {
    const message = sanitizeErrorMessage(error.message);
    if (message) safe.message = message;
    const stack = stackFrames(error.stack);
    if (stack) safe.stack = stack;
    if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH)
      safe.cause = serializeError(error.cause, depth + 1);
  }
  return safe;
}
