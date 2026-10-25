output "relay_urls" {
  description = "Relay URLs for the plugin's and the app's relay lists."
  value       = [for region, name in local.relays : "https://${name}/"]
}

output "relays" {
  description = "Per-region addresses."
  value       = { for region, name in local.relays : region => { hostname = name, ipv4 = vultr_instance.relay[region].main_ip, ipv6 = vultr_instance.relay[region].v6_main_ip } }
}
