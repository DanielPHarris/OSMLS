CREATE TABLE "OsmlsJobRun" (
	"RunKey" bigserial PRIMARY KEY NOT NULL,
	"Job" text NOT NULL,
	"StartedAt" timestamp with time zone NOT NULL,
	"FinishedAt" timestamp with time zone NOT NULL,
	"Outcome" text NOT NULL,
	"Tasks" jsonb NOT NULL,
	CONSTRAINT "OsmlsJobRun_Job_valid" CHECK ("Job" IN ('scheduled', 'backup')),
	CONSTRAINT "OsmlsJobRun_Outcome_valid" CHECK ("Outcome" IN ('Succeeded', 'Failed', 'Skipped'))
);
--> statement-breakpoint
CREATE TABLE "OsmlsCondition" (
	"ConditionKey" bigserial PRIMARY KEY NOT NULL,
	"Condition" text NOT NULL,
	"Detail" text NOT NULL,
	"BeganAt" timestamp with time zone NOT NULL,
	"LastReportedAt" timestamp with time zone,
	"ClearedAt" timestamp with time zone,
	"ClearSettledAt" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "OsmlsJobRun_latest" ON "OsmlsJobRun" USING btree ("Job","FinishedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "OsmlsCondition_open_once" ON "OsmlsCondition" USING btree ("Condition") WHERE "OsmlsCondition"."ClearedAt" IS NULL;