# DSH Remote

Continue a DeepSeek Harness (DSH) session from a native Android/iOS app, from anywhere. The phone
reaches the DSH host over an end-to-end encrypted iroh connection (QUIC, TLS 1.3, authenticated
by the host's key). There is no domain, VPN, port forwarding or exposed DSH Web UI.

Status: milestone 2. The plugin and protocol run on iroh (M1 done); next come the phone transport,
the relays and encrypted push. The product contract is
[DSH_Remote_Native_Product_and_Implementation_Spec_v0.3.md](DSH_Remote_Native_Product_and_Implementation_Spec_v0.3.md);
its Cloudflare transport sections are superseded by iroh. Deviations forced by upstream DSH are
recorded in `docs/`.

## Layout

| Path | Contents |
| --- | --- |
| `protocol/` | Wire schema and shared test vectors (Node + Dart) |
| `packages/protocol/` | Canonical signing string, pairing QR v2, cursor codec, error and event types |
| `packages/dsh-plugin/` | DSH plugin: `/rc`, iroh endpoint, pairing, device proofs, events, approvals; `dsh-remote` CLI |
| `apps/mobile/` | Flutter app |
| `deployment/` | systemd and launchd service templates and installer (plus Sprint 1 Cloudflare tooling, to be removed) |
| `spikes/` | Throwaway Phase 0 probes |

## Requirements

- Node 24.9+ (`.nvmrc`) and pnpm 11
- Flutter 3.29+ for `apps/mobile`

## Tests

| Command | What it runs |
| --- | --- |
| `pnpm test` | protocol and plugin unit tests, including the API over local iroh connections |
| `pnpm --filter @dsh-remote/dsh-plugin test:dsh` | a real `dsh web` 0.2.1-rc.3 with the plugin, driven over iroh |
| `IROH_RELAY_BIN=… pnpm --filter @dsh-remote/dsh-plugin test:relay` | the relayed path through a local `iroh-relay --dev` |

Host setup: [docs/setup.md](docs/setup.md).
