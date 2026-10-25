// Local smoke test for spikes/echo-origin/server.mjs with a self-made issuer.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import WebSocket from 'ws';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const issuer = 'http://127.0.0.1:4390';
createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))).listen(4390, '127.0.0.1');
const origin = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url).pathname, env: { ...process.env, CF_TEAM_DOMAIN: 'team.invalid', CF_AUD: 'aud-1', CF_ISSUER: issuer, GATE_LOG: '/dev/null' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => origin.stdout.once('data', r));
const sign = (claims, aud = 'aud-1') => new SignJWT({ email: 'me@example.com', type: 'app', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(aud).setSubject('user-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
const hit = async (headers) => (await fetch('http://127.0.0.1:4318/gate/hello', { headers })).status;
const results = {
  missing: await hit({}),
  valid: await hit({ 'cf-access-jwt-assertion': await sign({}) }),
  wrongAud: await hit({ 'cf-access-jwt-assertion': await sign({}, 'other') }),
  garbage: await hit({ 'cf-access-jwt-assertion': 'a.b.c' }),
};
results.ws = await new Promise(async (resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:4318/gate/ws', { headers: { 'cf-access-jwt-assertion': await sign({}) } });
  ws.on('message', (d) => { resolve(JSON.parse(d).type); ws.close(); });
  ws.on('unexpected-response', (_q, r) => resolve(`status ${r.statusCode}`));
});
results.wsUnauth = await new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:4318/gate/ws');
  ws.on('unexpected-response', (_q, r) => resolve(`status ${r.statusCode}`));
  ws.on('open', () => resolve('opened'));
  ws.on('error', (e) => resolve(`error ${e.message}`));
});
console.log(JSON.stringify(results));
origin.kill();
process.exit(0);
