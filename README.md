# DSH Remote

Continue a home-lab DeepSeek Harness (DSH) session from a native Android/iOS app over
Cloudflare Tunnel + Access — no VPN, no port forwarding, no exposed DSH Web UI.

Status: Sprint 1 in progress. The product contract is
[DSH_Remote_Native_Product_and_Implementation_Spec_v0.3.md](DSH_Remote_Native_Product_and_Implementation_Spec_v0.3.md);
deviations forced by upstream DSH are recorded in `docs/`.

## Layout

| Path | Contents |
| --- | --- |
| `protocol/` | Wire schema and shared test vectors (Node + Dart) |
| `packages/protocol/` | Canonical signing string, cursor codec, error and event types |
| `packages/dsh-plugin/` | DSH plugin: `/rc`, loopback API, Access JWT verification, pairing, events, approvals; `dsh-remote` CLI |
| `packages/test-phone/` | Node client that plays the phone's side of the protocol |
| `apps/mobile/` | Flutter app |
| `deployment/` | cloudflared, link-site, systemd and launchd templates |
| `spikes/` | Throwaway Phase 0 probes |

## Requirements

- Node 24.9+ (`.nvmrc`) and pnpm 11
- Flutter 3.29+ for `apps/mobile`
