variable "regions" {
  description = "Vultr region ids that each get one relay, named <region>1.<relay_domain>. The pilot is Tokyo only."
  type        = list(string)
  default     = ["nrt"]
}

variable "relay_plan" {
  description = "Vultr plan for every relay (High Performance AMD: 1 vCPU, 1 GB, NVMe, 2 TB)."
  type        = string
  default     = "vhp-1c-1gb-amd"
}

variable "os_id" {
  description = "Vultr OS image: Debian 13 x64 (trixie)."
  type        = number
  default     = 2625
}

variable "zone" {
  description = "Cloudflare zone that holds the relay records."
  type        = string
  default     = "pentacoxian.dev"
}

variable "relay_domain" {
  description = "Parent name for relay hostnames. Records are DNS-only: relays terminate their own TLS and take UDP."
  type        = string
  default     = "relay.dshremote.pentacoxian.dev"
}

variable "iroh_relay" {
  description = "Pinned iroh-relay release asset (static musl build) and its sha256."
  type = object({
    version = string
    sha256  = string
  })
  default = {
    version = "1.4.1"
    sha256  = "75254641e3fad7fcbac6dee4d485556fbe06ef708340a9d8810469270ba626b8"
  }
}

variable "acme_contact" {
  description = "Contact address for the relays' Let's Encrypt account (iroh-relay requires one)."
  type        = string
  default     = "acme@pentacoxian.dev"
}

variable "client_rx_bytes_per_second" {
  description = "Per-client relay rate limit. DSH Remote traffic is text; this caps what an abusive client can push through an open relay."
  type        = number
  default     = 1048576
}

variable "admin_ssh_public_key_file" {
  description = "Optional SSH public key for the root account; null leaves SSH closed (use the Vultr console)."
  type        = string
  default     = null
}

variable "admin_cidrs" {
  description = "Source networks allowed to reach SSH (port 22), e.g. [\"203.0.113.7/32\"]. Empty keeps port 22 closed."
  type        = list(string)
  default     = []
}
