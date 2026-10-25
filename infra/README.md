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
