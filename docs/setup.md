# Host setup

This is a one-time task on the machine that runs DSH. There is no domain, account, tunnel, VPN or
open port to set up. The plugin reaches phones over an end-to-end encrypted iroh connection: QUIC
with TLS 1.3, authenticated by the host's own key.

The phone app shows **DSH Web itself**, carried through that connection. A paired phone has the
same owner access as a browser on the host: every session, plugins, settings and automation.
Pair only phones you control.

## 0. Prerequisites

| Need | Check |
| --- | --- |
| Node 24.9+ | `node -v` (DSH refuses older versions) |
| DSH 0.2.1-rc.3, the pinned version | `npm i -g @deepseek-ai/dsh@0.2.1-rc.3`, then `dsh --version` |
| pnpm 11.23+ (DSH installs plugins with it; 11.0 to 11.22 can keep running after an install, so the installer stops) | `pnpm -v`; update with `pnpm self-update 11` |
| macOS on Apple silicon, or Linux x64/arm64 | `@number0/iroh` ships no Intel-Mac build |

## 1. Build and install the plugin

From a release (built and smoke-tested by CI on every `v*` tag), on any machine with DSH:

```sh
curl -fsSL https://github.com/pentaCoxian/dsh-remote/releases/latest/download/install.mjs | node --input-type=module -
```

- **What it does:** downloads the release's plugin tarball and dsh-mobile-maxxing into
  `$DSH_HOME/plugin-tarballs`, checks their SHA-256, then runs
  `dsh plugin --profile web add <both files>`. Options go after the `-`: a version (`0.1.1`) and
  `--profile <name>`.
- **Why not `dsh plugin add <URL>`:** DSH's pnpm records no integrity for a tarball added by URL and
  then refuses every later install in that profile (`ERR_PNPM_MISSING_TARBALL_INTEGRITY`). The
  0.1.0 instructions did that; the installer repairs such a profile before adding the files.
- **Upgrade later:** `dsh-remote upgrade [version]` does the same, or rerun the line above. It hands DSH
  only what changes: nothing when the profile is up to date, and a newer dsh-mobile-maxxing is kept.

Or from source:

```sh
pnpm install
pnpm -r build
dsh plugin --profile web add "$PWD/packages/dsh-plugin" ~/.dsh/plugin-tarballs/dsh-mobile-maxxing-0.6.0.tgz
```

(The installer above leaves that dsh-mobile-maxxing file there.)

Then restart DSH.

DSH Remote requires [dsh-mobile-maxxing](https://github.com/kuraneko1/dsh-mobile-maxxing) (MIT),
version 0.6.0 or later, which gives DSH Web its phone layout.
- **Why a separate install:** DSH loads only the plugins its profile lists itself, so it is added
  next to DSH Remote rather than coming as a dependency.
- **If it is missing:** `/rc status`, `dsh-remote doctor` and the app all say so.
- **Its own notifications:** its Web Push reaches browsers and installed PWAs. Inside the app's
  WebView it stays quiet; the app gets DSH Remote's own end-to-end encrypted notifications.

The plugin works with no configuration. Optional settings go in
`$DSH_HOME/profiles/web/cordis.patch.yml` (default `~/.dsh`):

```yaml
- id: dsh-remote
  config:
    hostName: Home Lab             # shown on the phone; default: this machine's hostname
    # relays: [https://…/]         # iroh relays; default: DSH Remote's Tokyo relay, then n0's public relays
    # relays: []                   # direct and LAN connections only
    # grantTtlDays: 90
    # remoteApprovalTimeoutSec: 900
    # pushGateway: null            # turn notifications off; default: DSH Remote's gateway on the Tokyo relay
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

- **Pair a new phone:**
  1. In DSH Web, send `/rc` on its own (or pick it from the `/` menu). A dialog shows a pairing QR.
     Without DSH Web, run `dsh-remote pair` in a terminal on the host; it prints the same QR.
  2. Scan the QR with DSH Remote → Connect Host, or with the camera app, which opens DSH Remote.
     The QR names this host's key, so the phone can only ever connect to this host.
  3. Compare the key fingerprints on both screens and approve: the dialog's Approve button, or `y`
     in the terminal. Approving gives the phone full DSH Web access.
  The dialog is live only: the QR and the fingerprint never enter the session log.
- **Use it:** tap the host in DSH Remote and DSH Web opens. Each opening is authorized by a request
  signed with the phone's hardware key, and DSH logs the phone in with its own owner cookie.
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
- **DSH Web must listen on plain HTTP** (the default). An HTTPS-only DSH Web is not tunnelled.
- **Android notifications need a Firebase build of the app.** Without `google-services.json` the
  Android app shows notifications as unavailable; iOS uses APNs.
