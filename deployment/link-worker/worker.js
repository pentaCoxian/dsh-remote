// DSH Remote public link host: app-link association files plus two static
// pages, nothing else. No API, no logging (the OAuth callback URL carries an
// authorization code, useless without the app's PKCE verifier but still not
// worth recording). Content comes from ./site.js, which
// `node deployment/render.mjs` generates from deployment/link-site/.
import { files } from './site.js';

const BASE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
};
const JSON_TYPE = 'application/json';
const HTML_TYPE = 'text/html; charset=utf-8';

/** path → [content type, body, cache-control] */
const ROUTES = new Map([
  ['/.well-known/apple-app-site-association', [JSON_TYPE, files.appleAppSiteAssociation, 'public, max-age=3600']],
  ['/.well-known/assetlinks.json', [JSON_TYPE, files.assetLinks, 'public, max-age=3600']],
  ['/', [HTML_TYPE, files.index, 'public, max-age=3600']],
  ['/oauth/callback', [HTML_TYPE, files.oauthCallback, 'no-store']],
  ['/p', [HTML_TYPE, files.pairing, 'no-store']],
]);

export default {
  fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...BASE, allow: 'GET, HEAD' } });
    }
    const path = new URL(request.url).pathname;
    const route = ROUTES.get(path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);
    if (route === undefined) {
      return new Response('Not found\n', { status: 404, headers: { ...BASE, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const [type, body, cache] = route;
    return new Response(request.method === 'HEAD' ? null : body, { headers: { ...BASE, 'content-type': type, 'cache-control': cache } });
  },
};
