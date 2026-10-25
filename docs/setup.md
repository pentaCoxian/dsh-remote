# Host setup

This is a one-time task on the machine that runs DSH. There is no domain, account, tunnel, VPN or
open port to set up. The plugin reaches phones over an end-to-end encrypted iroh connection: QUIC
with TLS 1.3, authenticated by the host's own key.

## 0. Prerequisites

| Need | Check |
| --- | --- |
| Node 24.9+ | `node -v` (DSH refuses older versions) |
| DSH 0.2.1-rc.3, the pinned version | `npm i -g @deepseek-ai/dsh@0.2.1-rc.3`, then `dsh --version` |
| pnpm 11 (building from source) | `pnpm -v` |
| macOS on Apple silicon, or Linux x64/arm64 | `@number0/iroh` ships no Intel-Mac build |

## 1. Build and install the plugin

```sh
pnpm install
pnpm -r build
dsh plugin --profile web add "$PWD/packages/dsh-plugin"
```

The plugin works with no configuration. Optional settings go in
`$DSH_HOME/profiles/web/cordis.patch.yml` (default `~/.dsh`):

```yaml
- id: dsh-remote
  config:
    hostName: Home Lab             # shown on the phone; default: this machine's hostname
    # relays: [https://…/]         # iroh relays; default: n0's public relays for now
    # relays: []                   # direct and LAN connections only
    # grantTtlDays: 90
    # remoteApprovalTimeoutSec: 900
```

- **Upgrading from the Cloudflare setup:** remove `publicHost`, `linkOrigin`, `access` and `port`.
  `/rc` reports any that are left, and phones paired before must pair again.
- **Ports:** DSH Web stays on `127.0.0.1:3080`. The plugin opens no TCP port at all; it makes
  outbound connections to its relay and to phones.

## 2. Supervised service

```sh
node deployment/install.mjs --dry-run      # review exactly what will be written and run
node deployment/install.mjs
```

- **Linux:** systemd user unit `dsh-remote-host.service`. Run `sudo loginctl enable-linger $USER`
  so it starts at boot.
- **macOS:** launchd agent `dev.dshremote.host`. Logs go to `~/Library/Logs/dsh-remote/`. A
  sleeping Mac takes the host offline.
- **Old installs:** a Sprint 1 cloudflared service, if present, is stopped and removed.
- **Remove:** `node deployment/install.mjs --uninstall` removes the service and leaves state and
  config in place.

## 3. Verify

```sh
node packages/dsh-plugin/dist/cli/main.js doctor     # or put `dsh-remote` on PATH
```

`doctor` is read-only. It checks:

- the Node version and the state-file permissions (`endpoint-key`, `state.json`);
- that the plugin is running with the production entry and has no TCP listener;
- that the host is connected to a home relay;
- that a fresh iroh endpoint can reach the host through that relay, as a phone off your network
  would.

## 4. Daily use

Work in DSH Web at `http://127.0.0.1:3080`, opened on the host or through an SSH port forward.

- **Hand a session to a phone:** run `/rc` in the session. Phones see only published sessions;
  `/rc off` unpublishes it and local work continues.
- **Pair a new phone:**
  1. Run `dsh-remote pair --session <id>` in a terminal on the host.
  2. Scan the QR from DSH Remote → Connect Host. The QR names this host's key, so the phone can
     only ever connect to this host.
  3. Compare the key fingerprints on both screens and approve with `y`.
- **Manage phones:** `dsh-remote devices`, `dsh-remote revoke <deviceId>`, `/rc devices`,
  `/rc revoke <deviceId>`. Revoking closes the phone's connection.

## What the network sees

- **Relays** forward encrypted QUIC packets and never see content. They do see which keys talk to
  each other, when, and how much. Phones and the host switch to a direct path when hole punching
  succeeds.
- **The pairing QR** carries the host's key, its home relay and its current addresses (LAN and
  public). It is not a credential, but treat it like an address and do not post it.
- **State:** the host's iroh key is `endpoint-key` in `$DSH_HOME/remote/` (0600). Deleting it gives
  the host a new identity, and every phone must pair again.

## Limits

- **Sessions must belong to the supervised host.** DSH allows one writer per session, so a session
  opened by another `dsh` process cannot be controlled remotely.
- **If DSH stops, the phone shows the host as offline.**
- **The `/rc` QR card in DSH Web is not built yet.** Pair with `dsh-remote pair` in a terminal.
