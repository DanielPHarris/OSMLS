CREATE TABLE "OsmlsDataConsumer" (
	"ConsumerKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ConsumerName" text NOT NULL,
	"OsmlsTokenHash" text NOT NULL,
	"CreatedByMemberKey" uuid NOT NULL,
	"OriginalEntryTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"ExpirationTimestamp" timestamp with time zone,
	"RevokedTimestamp" timestamp with time zone,
	"RevokedByMemberKey" uuid,
	CONSTRAINT "OsmlsDataConsumer_OsmlsTokenHash_unique" UNIQUE("OsmlsTokenHash"),
	CONSTRAINT "OsmlsDataConsumer_name_present" CHECK (length(trim("OsmlsDataConsumer"."ConsumerName")) > 0),
	CONSTRAINT "OsmlsDataConsumer_revoked_by_someone" CHECK (("OsmlsDataConsumer"."RevokedTimestamp" IS NULL) = ("OsmlsDataConsumer"."RevokedByMemberKey" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "OsmlsDataRequest" (
	"RequestKey" bigserial PRIMARY KEY NOT NULL,
	"ConsumerKey" uuid NOT NULL,
	"RequestTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"ResourceName" text NOT NULL,
	"Query" text NOT NULL,
	"Status" integer NOT NULL,
	"RecordCount" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "OsmlsDataConsumer" ADD CONSTRAINT "OsmlsDataConsumer_CreatedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("CreatedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsDataConsumer" ADD CONSTRAINT "OsmlsDataConsumer_RevokedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("RevokedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsDataRequest" ADD CONSTRAINT "OsmlsDataRequest_ConsumerKey_OsmlsDataConsumer_ConsumerKey_fk" FOREIGN KEY ("ConsumerKey") REFERENCES "public"."OsmlsDataConsumer"("ConsumerKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "OsmlsDataRequest_consumer" ON "OsmlsDataRequest" USING btree ("ConsumerKey","RequestTimestamp");--> statement-breakpoint
-- Whoever could already manage staff could grant this to themselves, so they start with it.
UPDATE "Member" SET "OsmlsCapabilities" = array_append("OsmlsCapabilities", 'data') WHERE 'staff' = ANY("OsmlsCapabilities") AND NOT 'data' = ANY("OsmlsCapabilities");
