# DSH Remote

Use your DeepSeek Harness (DSH) Web UI from your phone, from anywhere. The Android/iOS app carries
DSH Web over an end-to-end encrypted iroh connection (QUIC, TLS 1.3, authenticated by the host's
key), so there is no domain, VPN, port forwarding or publicly exposed DSH Web.

Status: the plugin, the Tokyo relay pilot and the phone app (DSH Web over the tunnel) work end to
end, on a real Pixel and the iOS simulator. Next is end-to-end encrypted push. The product contract is
[DSH_Remote_Native_Product_and_Implementation_Spec_v0.3.md](DSH_Remote_Native_Product_and_Implementation_Spec_v0.3.md);
its Cloudflare transport sections are superseded by iroh. Deviations forced by upstream DSH are
recorded in `docs/`.

## Layout

| Path | Contents |
| --- | --- |
| `protocol/` | Wire schema and shared test vectors (Node + Dart) |
| `packages/protocol/` | Canonical signing string, pairing QR v2, cursor codec, error and event types |
| `packages/dsh-plugin/` | DSH plugin: iroh endpoint, pairing, device proofs, the DSH Web tunnel; `dsh-remote` CLI |
| `apps/mobile/` | Flutter app: pairing, Rust iroh pipe (`native/`), DSH Web in a WebView |
| `infra/` | OpenTofu for the iroh relays (Vultr + Cloudflare DNS) |
| `deployment/` | systemd and launchd service templates and installer (plus Sprint 1 Cloudflare tooling, to be removed) |
| `spikes/` | Throwaway Phase 0 probes |

## Requirements

- Node 24.9+ (`.nvmrc`) and pnpm 11
- Flutter 3.29+ for `apps/mobile`
- On the host: DSH 0.2.1-rc.3 with [dsh-mobile-maxxing](https://github.com/kuraneko1/dsh-mobile-maxxing) 0.6.0+ next to the plugin, for DSH Web's phone layout (see [docs/setup.md](docs/setup.md))

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm test` | protocol and plugin unit tests, including the API over local iroh connections |
| `pnpm --filter @dsh-remote/dsh-plugin test:dsh` | a real `dsh web` 0.2.1-rc.3 with the plugin, driven over iroh |
| `IROH_RELAY_BIN=… pnpm --filter @dsh-remote/dsh-plugin test:relay` | the relayed path through a local `iroh-relay --dev` |

Host setup: [docs/setup.md](docs/setup.md).
