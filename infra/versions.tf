terraform {
  required_version = ">= 1.8"
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "2.33.2"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
  }
}

# Credentials come from the environment (see tofu.sh): VULTR_API_KEY, CLOUDFLARE_API_TOKEN.
provider "vultr" {
  rate_limit  = 700
  retry_limit = 3
}

provider "cloudflare" {}
