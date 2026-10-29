# DSH Remote

Use your DeepSeek Harness (DSH) Web UI from your phone, from anywhere. The Android/iOS app carries
DSH Web over an end-to-end encrypted iroh connection (QUIC, TLS 1.3, authenticated by the host's
key), so there is no domain, VPN, port forwarding or publicly exposed DSH Web.

Status: the plugin, the Tokyo relay and push gateway, and the phone app work end to end.
- **DSH Web:** it runs over the tunnel with its phone layout from
  [dsh-mobile-maxxing](https://github.com/kuraneko1/dsh-mobile-maxxing).
- **Notifications:** they are end-to-end encrypted.
- **Tested on devices:** a Pixel and an iPhone.

Setup: [docs/setup.md](docs/setup.md).

## Layout

| Path | Contents |
| --- | --- |
| `protocol/` | Wire schema and shared test vectors (Node + Dart) |
| `packages/protocol/` | Canonical signing string, pairing QR v2, cursor codec, error and event types |
| `packages/dsh-plugin/` | DSH plugin: iroh endpoint, pairing, device proofs, the DSH Web tunnel; `dsh-remote` CLI |
| `apps/mobile/` | Flutter app: pairing, Rust iroh pipe (`native/`), DSH Web in a WebView |
| `infra/` | OpenTofu for the iroh relays (Vultr + Cloudflare DNS) |
| `deployment/` | systemd and launchd service templates and installer; the App Review host (`review/`) (plus Sprint 1 Cloudflare tooling, to be removed) |
| `spikes/` | Throwaway Phase 0 probes |

## Requirements

- Node 24.9+ (`.nvmrc`) and pnpm 11.23+
- Flutter 3.29+ for `apps/mobile`
- On the host: DSH 0.2.1-rc.3 with [dsh-mobile-maxxing](https://github.com/kuraneko1/dsh-mobile-maxxing) 1.0.0 (0.6.0 or later works) next to the plugin, for DSH Web's phone layout (see [docs/setup.md](docs/setup.md))

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm test` | protocol and plugin unit tests, including the API over local iroh connections |
| `pnpm --filter @dsh-remote/dsh-plugin test:dsh` | a real `dsh web` 0.2.1-rc.3 with the plugin, driven over iroh |
| `IROH_RELAY_BIN=… pnpm --filter @dsh-remote/dsh-plugin test:relay` | the relayed path through a local `iroh-relay --dev` |

Host setup: [docs/setup.md](docs/setup.md).
