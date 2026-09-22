ALTER TABLE "status_page_notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page_notifications" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "status_page_notifications_retry_idx" ON "status_page_notifications" USING btree ("status","next_attempt_at");