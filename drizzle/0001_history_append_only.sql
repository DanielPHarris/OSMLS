-- History rows are a permanent record: they can be inserted, never changed or removed.
CREATE FUNCTION osmls_history_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HistoryTransactional is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "HistoryTransactional_append_only"
  BEFORE UPDATE OR DELETE ON "HistoryTransactional"
  FOR EACH ROW EXECUTE FUNCTION osmls_history_is_append_only();
--> statement-breakpoint
CREATE TRIGGER "HistoryTransactional_no_truncate"
  BEFORE TRUNCATE ON "HistoryTransactional"
  FOR EACH STATEMENT EXECUTE FUNCTION osmls_history_is_append_only();
