import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RC_HINT, rcCommand } from '../src/dsh/commands.ts';
import type { RemoteHost } from '../src/host.ts';

const invocation = (rawInput: string) => ({ commandId: 'c1', agent: { id: 'a1', session: { id: 's1' } }, rawInput, signal: new AbortController().signal });

const host = {
  devices: () => [{ deviceId: 'dev_1', label: 'Pixel', platform: 'android', peer: 'p', shortFingerprint: 'aaaa bbbb', hardwareBacked: true, lastSeenAt: null, expiresAt: 0, revoked: false }],
  status: () => ({
    hostId: 'eda8b41424ffff',
    hostName: 'Lab',
    entry: 'production',
    transport: { homeRelay: 'https://relay.example/', relays: ['https://relay.example/'] },
    loopbackPort: null,
    web: 'ready',
    push: { gateway: '724f928c8cffff', devices: 1 },
    mobileUi: { version: '0.6.0', ok: true },
    published: [],
    devices: 1,
    pendingPairings: 0,
  }),
} as unknown as RemoteHost;

describe('/rc', () => {
  const rc = rcCommand({ host, problems: [], hostName: 'Lab' });

  it('points at the DSH Web dialog and the CLI for pairing, never printing a code', async () => {
    for (const input of ['', 'pair']) {
      const reply = await rc(invocation(input));
      expect(reply.kind).toBe('success');
      expect(reply.text).toContain('send /rc on its own in DSH Web');
      expect(reply.text).toMatch(/dsh-remote pair$/m);
      expect(reply.text).toContain('Paired phones: 1 (Pixel)');
      expect(reply.text).not.toContain('dshremote://');
    }
  });

  it('reports status, and usage for anything else', async () => {
    const status = await rc(invocation('status'));
    expect(status.text).toContain('Host: Lab (id eda8b41424)');
    expect(status.text).toContain('Notifications: on, through gateway 724f928c8c (1 phone registered)');
    expect(await rc(invocation('nonsense'))).toEqual({ kind: 'error', text: `Usage: /rc [${RC_HINT}]` });
  });

  it('says why when the host is not running', async () => {
    const reply = await rcCommand({ host: undefined, problems: ['relays must be https URLs'], hostName: 'Lab' })(invocation('status'));
    expect(reply).toMatchObject({ kind: 'error' });
    expect(reply.text).toContain('- relays must be https URLs');
  });
});

describe('the DSH Web client module', () => {
  const root = new URL('..', import.meta.url);

  it('is declared for DSH Web and shipped with the package', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    expect(manifest.dsh.client).toMatchObject({ platform: 'web', inject: [] });
    expect(manifest.exports['./client']).toBe('./client/client.js');
    expect(manifest.files).toContain('client');
  });

  it('opens the pairing dialog on a bare /rc and /remote-control, and leaves argued lines to the host', async () => {
    let definition: { id: string; factory(): { inject: string[]; apply(ctx: unknown): void } } | undefined;
    vi.stubGlobal('window', { __ModuleLoader__: { load: (loaded: typeof definition) => (definition = loaded) } });
    try {
      await import(pathToFileURL(new URL('client/client.js', root).pathname).href);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(definition?.id).toBe('@dsh-remote/dsh-plugin');
    const decorations: { name: string; available(): boolean; ui: { kind: string } }[] = [];
    const disposed: string[] = [];
    let dispose: (() => void) | undefined;
    const ctx = {
      inject(deps: string[], callback: (scope: { get(name: string): unknown }) => (() => void) | undefined) {
        expect(deps).toEqual(['commandUi']);
        const commandUi = { decorate: (decoration: (typeof decorations)[number]) => (decorations.push(decoration), () => disposed.push(decoration.name)) };
        dispose = callback({ get: (name) => (name === 'commandUi' ? commandUi : undefined) });
      },
    };
    definition!.factory().apply(ctx);
    expect(decorations.map((d) => d.name)).toEqual(['rc', 'remote-control']);
    for (const decoration of decorations) {
      expect(decoration.ui.kind).toBe('action');
      expect(decoration.available()).toBe(true);
    }
    dispose?.();
    expect(disposed).toEqual(['rc', 'remote-control']);
  });
});
