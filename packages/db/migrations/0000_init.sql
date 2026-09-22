CREATE TYPE "public"."assertion_kind" AS ENUM('keyword', 'not_keyword', 'jsonpath', 'header', 'response_time');--> statement-breakpoint
CREATE TYPE "public"."monitor_status" AS ENUM('UP', 'DEGRADED', 'PARTIAL_OUTAGE', 'DOWN', 'PAUSED', 'INCONCLUSIVE', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."monitor_type" AS ENUM('http', 'tcp', 'ping', 'dns', 'heartbeat', 'flow');--> statement-breakpoint
CREATE TYPE "public"."region_health_status" AS ENUM('healthy', 'degraded', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."incident_event_kind" AS ENUM('opened', 'region_failed', 'region_recovered', 'escalated', 'acked', 'resolved', 'note', 'flapping_detected', 'severity_changed');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('down', 'partial', 'degraded');--> statement-breakpoint
CREATE TYPE "public"."alert_channel_kind" AS ENUM('email', 'slack', 'discord', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."alert_delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"hashed_key" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"kind" "assertion_kind" NOT NULL,
	"target" text,
	"operator" text NOT NULL,
	"value" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"headers_encrypted" text,
	"body_encrypted" text,
	"expected_status_codes" integer[] DEFAULT '{200,201,202,204}'::integer[] NOT NULL,
	"extract" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"expected_every_seconds" integer DEFAULT 3600 NOT NULL,
	"grace_seconds" integer DEFAULT 300 NOT NULL,
	"last_ping_at" timestamp with time zone,
	"ping_token" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_certificates" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"cert_expires_at" timestamp with time zone,
	"cert_issuer" text,
	"cert_subject" text,
	"domain" text,
	"domain_expires_at" timestamp with time zone,
	"registrar" text,
	"checked_at" timestamp with time zone,
	"last_alerted_day_bucket" integer
);
--> statement-breakpoint
CREATE TABLE "monitor_regions" (
	"monitor_id" uuid NOT NULL,
	"region_code" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "monitor_regions_monitor_id_region_code_pk" PRIMARY KEY("monitor_id","region_code")
);
--> statement-breakpoint
CREATE TABLE "monitor_state" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"status" "monitor_status" DEFAULT 'PENDING' NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_check_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"current_incident_id" uuid,
	"current_cycle_id" uuid,
	"failing_regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_latency_ms" double precision
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "monitor_type" DEFAULT 'http' NOT NULL,
	"url" text NOT NULL,
	"method" text DEFAULT 'GET' NOT NULL,
	"headers_encrypted" text,
	"body_encrypted" text,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"follow_redirects" boolean DEFAULT true NOT NULL,
	"max_redirects" integer DEFAULT 5 NOT NULL,
	"expected_status_codes" integer[] DEFAULT '{200,201,202,204}'::integer[] NOT NULL,
	"quorum_ratio" numeric(3, 2) DEFAULT '0.60' NOT NULL,
	"min_regions_required" integer DEFAULT 2 NOT NULL,
	"confirmation_failures" integer DEFAULT 2 NOT NULL,
	"confirmation_successes" integer DEFAULT 2 NOT NULL,
	"degraded_threshold_ms" integer,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"group_name" text,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"code" text PRIMARY KEY NOT NULL,
	"city" text NOT NULL,
	"country" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health_status" "region_health_status" DEFAULT 'healthy' NOT NULL,
	"quarantined_until" timestamp with time zone,
	"quarantine_reason" text,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "slos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"target_percent" numeric(6, 3) DEFAULT '99.900' NOT NULL,
	"window_days" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_rollups_1h" (
	"monitor_id" uuid NOT NULL,
	"region_code" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"ok_count" integer NOT NULL,
	"p50_ms" double precision,
	"p95_ms" double precision,
	"p99_ms" double precision,
	"max_ms" double precision,
	CONSTRAINT "check_rollups_1h_monitor_id_region_code_bucket_pk" PRIMARY KEY("monitor_id","region_code","bucket")
);
--> statement-breakpoint
CREATE TABLE "check_rollups_5m" (
	"monitor_id" uuid NOT NULL,
	"region_code" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"ok_count" integer NOT NULL,
	"p50_ms" double precision,
	"p95_ms" double precision,
	"p99_ms" double precision,
	"max_ms" double precision,
	CONSTRAINT "check_rollups_5m_monitor_id_region_code_bucket_pk" PRIMARY KEY("monitor_id","region_code","bucket")
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"region_code" text NOT NULL,
	"cycle_id" uuid,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"failure_code" text,
	"error_detail" text,
	"dns_ms" double precision,
	"tcp_ms" double precision,
	"tls_ms" double precision,
	"ttfb_ms" double precision,
	"transfer_ms" double precision,
	"total_ms" double precision NOT NULL,
	"response_size_bytes" bigint,
	"resolved_ip" "inet",
	"cert_expires_at" timestamp with time zone,
	"body_snippet" text,
	"response_headers" jsonb,
	CONSTRAINT "checks_id_checked_at_pk" PRIMARY KEY("id","checked_at")
) PARTITION BY RANGE ("checked_at");
--> statement-breakpoint
CREATE TABLE "latency_baselines" (
	"monitor_id" uuid NOT NULL,
	"region_code" text NOT NULL,
	"p95_ms" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "latency_baselines_monitor_id_region_code_pk" PRIMARY KEY("monitor_id","region_code")
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "incident_event_kind" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"severity" "incident_severity" NOT NULL,
	"primary_failure_code" text,
	"affected_regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"postmortem" text,
	"is_flapping" text
);
--> statement-breakpoint
CREATE TABLE "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "alert_channel_kind" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "alert_delivery_status" DEFAULT 'pending' NOT NULL,
	"response_code" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "escalation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"after_minutes" integer DEFAULT 0 NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"monitor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"rrule" text,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_policies" (
	"monitor_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	CONSTRAINT "monitor_policies_monitor_id_policy_id_pk" PRIMARY KEY("monitor_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE "status_page_monitors" (
	"status_page_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"group_name" text DEFAULT 'Services' NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "status_page_monitors_status_page_id_monitor_id_pk" PRIMARY KEY("status_page_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "status_page_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status_page_id" uuid NOT NULL,
	"email" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirm_token" text NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"custom_domain" text,
	"domain_verification_token" text,
	"domain_verified_at" timestamp with time zone,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"password_hash" text,
	"show_uptime_days" integer DEFAULT 90 NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assertions" ADD CONSTRAINT "assertions_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_certificates" ADD CONSTRAINT "monitor_certificates_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_regions" ADD CONSTRAINT "monitor_regions_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_regions" ADD CONSTRAINT "monitor_regions_region_code_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."regions"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_state" ADD CONSTRAINT "monitor_state_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slos" ADD CONSTRAINT "slos_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_rollups_1h" ADD CONSTRAINT "check_rollups_1h_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_rollups_5m" ADD CONSTRAINT "check_rollups_5m_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "latency_baselines" ADD CONSTRAINT "latency_baselines_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_channel_id_alert_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_steps" ADD CONSTRAINT "escalation_steps_policy_id_escalation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."escalation_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_policies" ADD CONSTRAINT "monitor_policies_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_policies" ADD CONSTRAINT "monitor_policies_policy_id_escalation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."escalation_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_subscribers" ADD CONSTRAINT "status_page_subscribers_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hashed_key_unique" ON "api_keys" USING btree ("hashed_key");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_org_user_unique" ON "members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "members_user_id_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_unique" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "assertions_monitor_idx" ON "assertions" USING btree ("monitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_steps_monitor_order_unique" ON "flow_steps" USING btree ("monitor_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeats_token_unique" ON "heartbeats" USING btree ("ping_token");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeats_monitor_unique" ON "heartbeats" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "monitor_regions_region_idx" ON "monitor_regions" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "monitor_state_next_run_idx" ON "monitor_state" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "monitor_state_status_idx" ON "monitor_state" USING btree ("status");--> statement-breakpoint
CREATE INDEX "monitors_org_idx" ON "monitors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "monitors_org_paused_idx" ON "monitors" USING btree ("organization_id","paused");--> statement-breakpoint
CREATE UNIQUE INDEX "slos_monitor_unique" ON "slos" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "rollups_1h_monitor_bucket_idx" ON "check_rollups_1h" USING btree ("monitor_id","bucket" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rollups_5m_monitor_bucket_idx" ON "check_rollups_5m" USING btree ("monitor_id","bucket" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checks_monitor_checked_idx" ON "checks" USING btree ("monitor_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checks_monitor_region_checked_idx" ON "checks" USING btree ("monitor_id","region_code","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checks_cycle_idx" ON "checks" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "incident_events_incident_at_idx" ON "incident_events" USING btree ("incident_id","at");--> statement-breakpoint
CREATE INDEX "incidents_monitor_started_idx" ON "incidents" USING btree ("monitor_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_open_idx" ON "incidents" USING btree ("monitor_id","started_at" DESC NULLS LAST) WHERE "incidents"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "alert_channels_org_idx" ON "alert_channels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "alert_deliveries_incident_idx" ON "alert_deliveries" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_dedup_idx" ON "alert_deliveries" USING btree ("incident_id","channel_id","kind","step_index");--> statement-breakpoint
CREATE INDEX "escalation_policies_org_idx" ON "escalation_policies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "escalation_steps_policy_idx" ON "escalation_steps" USING btree ("policy_id","order_index");--> statement-breakpoint
CREATE INDEX "maintenance_windows_org_idx" ON "maintenance_windows" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_time_idx" ON "maintenance_windows" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "status_page_monitors_page_idx" ON "status_page_monitors" USING btree ("status_page_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_subscribers_unique" ON "status_page_subscribers" USING btree ("status_page_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_subscribers_confirm_token" ON "status_page_subscribers" USING btree ("confirm_token");--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_subscribers_unsub_token" ON "status_page_subscribers" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_slug_unique" ON "status_pages" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_custom_domain_unique" ON "status_pages" USING btree ("custom_domain");--> statement-breakpoint
CREATE INDEX "status_pages_org_idx" ON "status_pages" USING btree ("organization_id");