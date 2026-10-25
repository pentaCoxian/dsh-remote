# DSH Remote relays: one iroh-relay per region, each with its own hostname
# (iroh endpoints pick one home relay and are reached through that exact URL,
# so relays are never load-balanced). Relays hold no state beyond their TLS
# certificate and never see content: QUIC between phone and host is end to end.

locals {
  relays = { for region in var.regions : region => "${region}1.${var.relay_domain}" }
  open_ports = [
    { protocol = "tcp", port = "80" },   # captive-portal probe; Let's Encrypt uses TLS-ALPN on 443
    { protocol = "tcp", port = "443" },  # relay over WebSocket/TLS
    { protocol = "udp", port = "7842" }, # QUIC address discovery
  ]
  everywhere = [
    { ip_type = "v4", subnet = "0.0.0.0", size = 0 },
    { ip_type = "v6", subnet = "::", size = 0 },
  ]
  admin = [for cidr in var.admin_cidrs : { ip_type = strcontains(cidr, ":") ? "v6" : "v4", subnet = split("/", cidr)[0], size = tonumber(split("/", cidr)[1]) }]
}

data "cloudflare_zone" "this" {
  filter = { name = var.zone }
}

resource "vultr_firewall_group" "relay" {
  description = "dsh-remote relay"
}

resource "vultr_firewall_rule" "public" {
  for_each          = { for pair in setproduct(local.open_ports, local.everywhere) : "${pair[0].protocol}-${pair[0].port}-${pair[1].ip_type}" => merge(pair[0], pair[1]) }
  firewall_group_id = vultr_firewall_group.relay.id
  protocol          = each.value.protocol
  port              = each.value.port
  ip_type           = each.value.ip_type
  subnet            = each.value.subnet
  subnet_size       = each.value.size
  notes             = "dsh-remote relay"
}

resource "vultr_firewall_rule" "ssh" {
  for_each          = { for net in local.admin : "${net.subnet}/${net.size}" => net }
  firewall_group_id = vultr_firewall_group.relay.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = each.value.ip_type
  subnet            = each.value.subnet
  subnet_size       = each.value.size
  notes             = "dsh-remote admin ssh"
}

resource "vultr_ssh_key" "admin" {
  count   = var.admin_ssh_public_key_file == null ? 0 : 1
  name    = "dsh-remote admin"
  ssh_key = trimspace(file(var.admin_ssh_public_key_file))
}

resource "vultr_instance" "relay" {
  for_each          = local.relays
  region            = each.key
  plan              = var.relay_plan
  os_id             = var.os_id
  label             = "dsh-relay-${each.key}1"
  hostname          = each.value
  enable_ipv6       = true
  backups           = "disabled"
  ddos_protection   = false
  activation_email  = false
  firewall_group_id = vultr_firewall_group.relay.id
  ssh_key_ids       = vultr_ssh_key.admin[*].id
  tags              = ["dsh-remote", "relay"]
  user_data = templatefile("${path.module}/templates/relay.cloud-init.yaml.tftpl", {
    hostname    = each.value
    zone        = var.zone
    version     = var.iroh_relay.version
    sha256      = var.iroh_relay.sha256
    relay_toml  = templatefile("${path.module}/templates/relay.toml.tftpl", { hostname = each.value, contact = var.acme_contact, rx_bytes_per_second = var.client_rx_bytes_per_second })
  })

  # cloud-init runs once: a changed template only takes effect on a new instance.
  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "cloudflare_dns_record" "relay_a" {
  for_each = local.relays
  zone_id  = data.cloudflare_zone.this.id
  name     = each.value
  type     = "A"
  content  = vultr_instance.relay[each.key].main_ip
  ttl      = 300
  proxied  = false
  comment  = "dsh-remote relay (managed by infra/)"
}

resource "cloudflare_dns_record" "relay_aaaa" {
  for_each = local.relays
  zone_id  = data.cloudflare_zone.this.id
  name     = each.value
  type     = "AAAA"
  content  = vultr_instance.relay[each.key].v6_main_ip
  ttl      = 300
  proxied  = false
  comment  = "dsh-remote relay (managed by infra/)"
}
