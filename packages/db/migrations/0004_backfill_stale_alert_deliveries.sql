-- Rows that failed before retry support existed carry status='failed' with no
-- next_attempt_at, so the retry claim predicate (pending, OR failed AND
-- next_attempt_at <= now()) can never see them. Treating NULL as "due now" would
-- page on-call about outages that resolved months ago, so retire them as 'dead'
-- instead: that is the honest terminal state, and it makes the backlog countable
-- via sentinel_alert_deliveries_dead_total rather than silently invisible.
UPDATE "alert_deliveries"
SET "status" = 'dead',
    "attempts" = GREATEST("attempts", 1),
    "error" = COALESCE("error", 'retired by migration 0004: predates delivery retries')
WHERE "status" = 'failed'
  AND "next_attempt_at" IS NULL;
--> statement-breakpoint
UPDATE "status_page_notifications"
SET "status" = 'dead',
    "attempts" = GREATEST("attempts", 1),
    "error" = COALESCE("error", 'retired by migration 0004: predates subscriber retries')
WHERE "status" = 'failed'
  AND "next_attempt_at" IS NULL;