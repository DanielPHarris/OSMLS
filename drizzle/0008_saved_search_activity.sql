ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsActivitySeenThrough" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsActivitySeenAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "HistoryTransactional_sequence_idx" ON "HistoryTransactional" USING btree ("OsmlsSequence");--> statement-breakpoint
-- Saved searches that already exist start from now: nothing earlier is activity.
UPDATE "SavedSearch" SET "OsmlsActivitySeenThrough" = (SELECT coalesce(max("OsmlsSequence"), 0) FROM "HistoryTransactional");
--> statement-breakpoint
-- History sequence numbers are handed out in the order their transactions
-- commit. Each transaction that writes history takes one lock first and keeps it
-- until it ends, and only then is the next number given. So a row can never
-- appear later with a lower number than one already visible, which is what lets
-- "seen through number N" mean that nothing at or below N is still to come.
-- The cost: transactions that change listings finish one at a time.
CREATE FUNCTION osmls_history_sequence_in_commit_order() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('osmls:HistoryTransactional:sequence'));
  NEW."OsmlsSequence" := nextval(pg_get_serial_sequence('"HistoryTransactional"', 'OsmlsSequence'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "HistoryTransactional_sequence_in_commit_order"
  BEFORE INSERT ON "HistoryTransactional"
  FOR EACH ROW EXECUTE FUNCTION osmls_history_sequence_in_commit_order();
