output "relay_urls" {
  description = "Relay URLs for the plugin's and the app's relay lists."
  value       = [for region, name in local.relays : "https://${name}/"]
}

output "relays" {
  description = "Per-region addresses."
  value       = { for region, name in local.relays : region => { hostname = name, ipv4 = vultr_instance.relay[region].main_ip, ipv6 = vultr_instance.relay[region].v6_main_ip } }
}

output "review" {
  description = "The App Review host, while it exists."
  value       = var.review ? { hostname = var.review_hostname, ipv4 = vultr_instance.review[0].main_ip, ipv6 = vultr_instance.review[0].v6_main_ip } : null
}
