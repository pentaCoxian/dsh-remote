# The App Review host (deployment/review): a VM that holds nothing else, since
# whoever pairs with it gets a shell in its container. It exists only while a
# store review is open: `review = true` in terraform.tfvars creates it, false
# deletes it with its DNS records.

resource "vultr_firewall_group" "review" {
  count       = var.review ? 1 : 0
  description = "dsh-remote review host"
}

resource "vultr_firewall_rule" "review_public" {
  for_each          = var.review ? { for pair in setproduct(["80", "443"], local.everywhere) : "tcp-${pair[0]}-${pair[1].ip_type}" => merge({ port = pair[0] }, pair[1]) } : {}
  firewall_group_id = vultr_firewall_group.review[0].id
  protocol          = "tcp"
  port              = each.value.port
  ip_type           = each.value.ip_type
  subnet            = each.value.subnet
  subnet_size       = each.value.size
  notes             = "dsh-remote review https"
}

resource "vultr_firewall_rule" "review_ssh" {
  for_each          = var.review ? { for net in local.admin : "${net.subnet}/${net.size}" => net } : {}
  firewall_group_id = vultr_firewall_group.review[0].id
  protocol          = "tcp"
  port              = "22"
  ip_type           = each.value.ip_type
  subnet            = each.value.subnet
  subnet_size       = each.value.size
  notes             = "dsh-remote admin ssh"
}

resource "vultr_instance" "review" {
  count             = var.review ? 1 : 0
  region            = var.review_region
  plan              = var.review_plan
  os_id             = var.os_id
  label             = "dsh-review"
  hostname          = var.review_hostname
  enable_ipv6       = true
  backups           = "disabled"
  ddos_protection   = false
  activation_email  = false
  firewall_group_id = vultr_firewall_group.review[0].id
  ssh_key_ids       = vultr_ssh_key.admin[*].id
  tags              = ["dsh-remote", "review"]
  user_data         = templatefile("${path.module}/templates/review.cloud-init.yaml.tftpl", { hostname = var.review_hostname })

  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "cloudflare_dns_record" "review_a" {
  count   = var.review ? 1 : 0
  zone_id = data.cloudflare_zone.this.id
  name    = var.review_hostname
  type    = "A"
  content = vultr_instance.review[0].main_ip
  ttl     = 300
  proxied = false
  comment = "dsh-remote review host (managed by infra/)"
}

resource "cloudflare_dns_record" "review_aaaa" {
  count   = var.review ? 1 : 0
  zone_id = data.cloudflare_zone.this.id
  name    = var.review_hostname
  type    = "AAAA"
  content = vultr_instance.review[0].v6_main_ip
  ttl     = 300
  proxied = false
  comment = "dsh-remote review host (managed by infra/)"
}
