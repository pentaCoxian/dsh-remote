# Home-lab setup

This is a one-time task for the home-lab admin. Nothing runs on its own:

- `deployment/provision.mjs` changes Cloudflare only when you run it with `--apply` and confirm,
  using your own token, which it never stores.
- The other scripts render templates and install user-level services.

## 0. Prerequisites

| Need | Check |
| --- | --- |
| Node 24.9+ | `node -v` (DSH refuses older versions) |
| DSH 0.2.1-rc.3, the pinned version | `npm i -g @deepseek-ai/dsh@0.2.1-rc.3`, then `dsh --version` |
| cloudflared | `cloudflared --version` |
| pnpm 11 | `pnpm -v` |
| A Cloudflare zone plus a Zero Trust organization | — |

## 1. Cloudflare

Run sections 1–4 of [cloudflare-gate.md](cloudflare-gate.md):

1. Fill in `site.env`.
2. Create a scoped API token.
3. Run `node deployment/provision.mjs --plan`, then `--apply`.
4. Run `wrangler deploy` for the link host.

Record the gate result. After the gate, run
`node deployment/provision.mjs --apply --gate off` to turn loopback redirects off again.

## 2. Build and install the plugin

```sh
pnpm install
pnpm -r build
dsh plugin --profile web add "$PWD/packages/dsh-plugin"
```

Configure it in `$DSH_HOME/profiles/web/cordis.patch.yml` (default `~/.dsh`). This row replaces
the plugin entry's config:

```yaml
- id: dsh-remote
  config:
    publicHost: dsh.example.com          # API_HOSTNAME (Access-protected, routed by the tunnel)
    linkOrigin: https://link.example.com # LINK_HOSTNAME (public static link site)
    hostName: Home Lab                   # shown on the phone
    access:
      teamName: myteam                   # <team>.cloudflareaccess.com
      audTags: [<AUD tag of the Access application>]
    # optional: port (4318), grantTtlDays (90), remoteApprovalTimeoutSec (900)
```

The native API listens on `127.0.0.1:4318` only. DSH Web stays on `127.0.0.1:3080` and is never
routed by the tunnel.

## 3. Supervised services

```sh
node deployment/render.mjs                 # renders deployment/out/ from deployment/site.env
node deployment/install.mjs --dry-run      # review exactly what will be written and run
node deployment/install.mjs
```

- **Linux:** systemd user units `dsh-remote-host.service` and `dsh-remote-cloudflared.service`.
  Run `sudo loginctl enable-linger $USER` so they start at boot.
- **macOS:** launchd agents `dev.dshremote.host` and `dev.dshremote.cloudflared`. Logs go to
  `~/Library/Logs/dsh-remote/`. A sleeping Mac takes the host offline.
- **Remove:** `node deployment/install.mjs --uninstall` removes both services. State and config
  are left in place.

## 4. Verify

```sh
node packages/dsh-plugin/dist/cli/main.js doctor     # or put `dsh-remote` on PATH
```

`doctor` is read-only. It checks:

- the Node version and the state-file permissions;
- that the plugin is running with the production entry;
- that the API is bound to loopback only;
- that the Access signing keys are reachable and cloudflared is ready;
- that an unauthenticated request **and** an unauthenticated WebSocket upgrade to
  `https://API_HOSTNAME` are refused at Cloudflare's edge without reaching the plugin.

## 5. Daily use

Work in DSH Web at `http://127.0.0.1:3080`, opened on the host or through an SSH port forward.

- **Hand a session to a phone:** run `/rc` in the session. The reply confirms remote control is
  on; phones see only published sessions. `/rc off` unpublishes it and local work continues.
- **Pair a new phone:**
  1. Run `dsh-remote pair --session <id>` in a terminal on the host.
  2. Scan the QR from DSH Remote → Connect Host.
  3. Compare the key fingerprints on both screens and approve with `y`.
- **Manage phones:** `dsh-remote devices`, `dsh-remote revoke <deviceId>`, `/rc devices`,
  `/rc revoke <deviceId>`.

## Limits

- **Sessions must belong to the supervised host.** DSH allows one writer per session, so a session
  opened by another `dsh` process cannot be controlled remotely.
- **If DSH stops, the phone shows the host as offline.** The tunnel cannot keep a stopped agent
  running.
- **Cloudflare terminates TLS.** It can process the content it relays; this is not end-to-end
  encryption.
- **The `/rc` QR card in DSH Web is not built yet.** Pair with `dsh-remote pair` in a terminal.
