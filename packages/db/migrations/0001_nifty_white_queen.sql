CREATE TABLE "status_page_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "alert_delivery_status" DEFAULT 'pending' NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "status_page_notifications" ADD CONSTRAINT "status_page_notifications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_notifications" ADD CONSTRAINT "status_page_notifications_subscriber_id_status_page_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."status_page_subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_page_notifications_status_idx" ON "status_page_notifications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "status_page_notifications_dedup_idx" ON "status_page_notifications" USING btree ("incident_id","subscriber_id","kind");