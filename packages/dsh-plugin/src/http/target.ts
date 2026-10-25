/**
 * Strict request-target grammar for the native API. A signed path has exactly
 * one spelling: no percent-encoding, no dot segments, no empty segments, no
 * duplicate or exotic query keys. Anything else is refused before routing, so
 * the signature, the router and DSH all see the same identifiers.
 */
export interface ParsedTarget {
  readonly path: string;
  readonly segments: readonly string[];
  readonly query: ReadonlyMap<string, string>;
}

export type TargetResult = { readonly ok: true; readonly target: ParsedTarget } | { readonly ok: false; readonly reason: 'path' | 'query' };

const SEGMENT = /^[A-Za-z0-9_.~-]{1,200}$/;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const QUERY_VALUE = /^[A-Za-z0-9_.~-]{1,700}$/;

export function parseTarget(raw: string): TargetResult {
  if (raw.length > 2048 || !raw.startsWith('/')) return { ok: false, reason: 'path' };
  const queryAt = raw.indexOf('?');
  const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === '.' || segment === '..')) return { ok: false, reason: 'path' };
  const query = new Map<string, string>();
  if (queryAt >= 0) {
    const text = raw.slice(queryAt + 1);
    if (text === '') return { ok: false, reason: 'query' };
    for (const pair of text.split('&')) {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      if (!QUERY_KEY.test(key) || !QUERY_VALUE.test(value) || query.has(key)) return { ok: false, reason: 'query' };
      query.set(key, value);
    }
  }
  return { ok: true, target: { path, segments, query } };
}

/** Route pattern such as `/v1/sessions/:sessionId/prompts`. */
export function matchPattern(pattern: readonly string[], segments: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index]!;
    if (part.startsWith(':')) params[part.slice(1)] = segment;
    else if (part !== segment) return undefined;
  }
  return params;
}
