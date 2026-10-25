/**
 * Event cursors are opaque to clients but carry the DSH session and its durable
 * log `seq`, so a cursor stays valid across plugin restarts. `seq` is the last
 * event the client holds; `-1` means "before the first event".
 */
export interface CursorValue {
  readonly sessionId: string;
  readonly seq: number;
}

const PREFIX = 'c1.';
const SESSION_ID = /^[\x21-\x7e]{1,200}$/;

export function encodeCursor(value: CursorValue): string {
  if (!SESSION_ID.test(value.sessionId) || !Number.isSafeInteger(value.seq) || value.seq < -1) {
    throw new Error('cursor: invalid value');
  }
  return PREFIX + Buffer.from(JSON.stringify({ s: value.sessionId, q: value.seq }), 'utf8').toString('base64url');
}

export function decodeCursor(text: string): CursorValue | undefined {
  if (!text.startsWith(PREFIX) || text.length > 603) return undefined;
  const body = text.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { s, q } = parsed as Record<string, unknown>;
  if (typeof s !== 'string' || !SESSION_ID.test(s)) return undefined;
  if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < -1) return undefined;
  if (Object.keys(parsed).length !== 2) return undefined;
  return { sessionId: s, seq: q };
}
