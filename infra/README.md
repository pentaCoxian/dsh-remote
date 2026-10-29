# DSH Remote relays

OpenTofu for the DSH Remote iroh relays: one Vultr instance per region running a pinned
`iroh-relay`, plus DNS-only Cloudflare records. Relays forward end-to-end encrypted QUIC and
never see content. Each relay has its own hostname, because an iroh endpoint is reached through
its home relay's exact URL; relays are never put behind a load balancer.

| Resource | Pilot (`regions = ["nrt"]`) |
| --- | --- |
| Instance | `nrt1.relay.dshremote.pentacoxian.dev`, `vhp-1c-1gb-amd` (1 vCPU, 1 GB, NVMe, 2 TB), Debian 13, $6/mo |
| Firewall | 80/tcp, 443/tcp, 7842/udp from anywhere; 22/tcp only from `admin_cidrs` |
| DNS | A and AAAA, proxy off (the relay terminates its own TLS and takes UDP) |
| TLS | Let's Encrypt via TLS-ALPN-01 on 443; ACME contact `acme_contact` (a role address) |

## Use

```sh
infra/tofu.sh init
infra/tofu.sh plan -out=pilot.tfplan     # review
infra/tofu.sh apply pilot.tfplan          # creates billable resources
infra/tofu.sh output relay_urls
```

- **Credentials:** `tofu.sh` reads `VULTR_API_TOKEN` and `CLOUDFLARE_API_TOKEN` from the repo's
  `.env` and never prints them.
- **State:** the state holds the instances' root passwords, so it stays local (gitignored,
  owner-only).
- **Admin SSH (optional):** set `admin_ssh_public_key_file` and `admin_cidrs` in the gitignored
  `terraform.tfvars`.
- **Changes:** cloud-init runs once at first boot, so a changed template takes effect only on a
  replaced instance: `infra/tofu.sh apply -replace='vultr_instance.relay["nrt"]'`. A replacement
  gets a new certificate (Let's Encrypt allows 5 per hostname per week).
- **More regions:** add region ids to `regions`, e.g. `["nrt", "sgp", "bom", "fra", "ewr", "lax",
  "sao"]`. São Paulo costs $9 for the same plan.

## Checks

```sh
curl -sI https://nrt1.relay.dshremote.pentacoxian.dev/ping       # 200 from iroh-relay
ssh root@nrt1.relay.dshremote.pentacoxian.dev journalctl -u iroh-relay -n 50
```

## Push gateway

The push gateway (`packages/push-gateway`) runs on the pilot relay box, next to
`iroh-relay`. It is reached over iroh (`dsh-remote/push/1`, home relay nrt1),
so it needs no extra port, firewall rule or certificate.

```sh
infra/push/deploy.sh      # confirm with the owner first: it changes the live box
```

- **What it installs:**
  - Node 24.17.0 under `/opt/node`, checked against its sha256.
  - The bundle under `/opt/dshr-push/releases/<commit>`, with `/opt/dshr-push/current` pointing at it.
  - The hardened unit `dshr-push.service`: DynamicUser, a 256 MB cap, no capabilities.
- **Credentials:** read from `.env` (`APNS_KEY_FILE`, `APNS_KEY_ID`, `FCM_SERVICE_ACCOUNT_FILE`).
  - They are copied to `/etc/dshr-push` (root, 0600) and passed in with `LoadCredential`.
  - They are never printed.
  - A platform without credentials stays off.
- **Identity:** the gateway's iroh key lives in `/var/lib/private/dshr-push/endpoint-key`.
  Hosts pin its EndpointId (`DEFAULT_PUSH_GATEWAY` in `packages/dsh-plugin/src/dsh/config.ts`).
  When replacing the instance, carry the key over.
- **SSH:** the deploy trusts only the host key in `infra/push/known_hosts`. It was recorded on
  first contact on 2026-10-26: ED25519 `SHA256:j2TMSsBi+F99TsqYPY1cp79wrcshZxE4/bKSh1VdnGY`.
- **Logs:** counts and short hashes only.

```sh
ssh -o UserKnownHostsFile=infra/push/known_hosts root@nrt1.relay.dshremote.pentacoxian.dev journalctl -u dshr-push -n 50
```

## App Review host

`review.tf` makes a throwaway VM for the store reviewers' host (`review = true` in
`terraform.tfvars`; off by default) and `infra/review/deploy.sh` brings the host
up on it. How to run it, take it down and what to tell the reviewers:
[deployment/review/README.md](../deployment/review/README.md).
