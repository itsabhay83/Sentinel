output "postgres_endpoint" {
  description = "Host:port for DATABASE_URL. The password lives in Secrets Manager."
  value       = module.postgres.endpoint
}

output "postgres_secret_arn" {
  description = "Secrets Manager ARN holding the generated master password."
  value       = module.postgres.password_secret_arn
}

output "redis_endpoint" {
  description = "Primary endpoint for REDIS_URL (TLS in transit is enabled, use rediss://)."
  value       = module.redis.primary_endpoint
}

output "registry_urls" {
  description = "Image repository per Dockerfile target."
  value       = module.registry.repository_urls
}

output "probe_region_endpoints" {
  description = "Per-region probe compute identifiers, keyed by Sentinel region code."
  value = {
    for entry in [
      { code = "bom", mod = module.probe_bom },
      { code = "sin", mod = module.probe_sin },
      { code = "fra", mod = module.probe_fra },
      { code = "lhr", mod = module.probe_lhr },
      { code = "iad", mod = module.probe_iad },
      { code = "sjc", mod = module.probe_sjc },
      { code = "gru", mod = module.probe_gru },
      { code = "syd", mod = module.probe_syd },
    ] : entry.code => one(entry.mod[*].service_name) if length(entry.mod) > 0
  }
}
