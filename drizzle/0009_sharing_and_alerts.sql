CREATE TABLE "OsmlsMailBlock" (
	"OsmlsAddressHash" text PRIMARY KEY NOT NULL,
	"OriginalEntryTimestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OsmlsShare" (
	"ShareKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"MemberKey" uuid NOT NULL,
	"OsmlsTokenHash" text NOT NULL,
	"ListingKey" uuid,
	"CollectionKey" uuid,
	"ExpirationTimestamp" timestamp with time zone NOT NULL,
	"OsmlsRevokedTimestamp" timestamp with time zone,
	"OsmlsRecipientEmail" text,
	"OsmlsRecipientHash" text,
	"OsmlsSentTimestamp" timestamp with time zone,
	"OriginalEntryTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "OsmlsShare_OsmlsTokenHash_unique" UNIQUE("OsmlsTokenHash"),
	CONSTRAINT "OsmlsShare_one_target" CHECK (num_nonnulls("OsmlsShare"."ListingKey", "OsmlsShare"."CollectionKey") <= 1)
);
--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsAlertFrequency" text;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsAlertSentThrough" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsAlertLastSentAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsAlertAttempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsAlertFailures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsAlertPaused" text;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD COLUMN "OsmlsAlertGeneration" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "OsmlsShare" ADD CONSTRAINT "OsmlsShare_MemberKey_Member_MemberKey_fk" FOREIGN KEY ("MemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsShare" ADD CONSTRAINT "OsmlsShare_ListingKey_Property_ListingKey_fk" FOREIGN KEY ("ListingKey") REFERENCES "public"."Property"("ListingKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsShare" ADD CONSTRAINT "OsmlsShare_CollectionKey_OsmlsCollection_CollectionKey_fk" FOREIGN KEY ("CollectionKey") REFERENCES "public"."OsmlsCollection"("CollectionKey") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "OsmlsShare_member_idx" ON "OsmlsShare" USING btree ("MemberKey");--> statement-breakpoint
CREATE INDEX "OsmlsShare_recipient_idx" ON "OsmlsShare" USING btree ("OsmlsRecipientHash");--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_alert_frequency_valid" CHECK ("SavedSearch"."OsmlsAlertFrequency" IS NULL OR "SavedSearch"."OsmlsAlertFrequency" IN ('daily', 'weekly'));--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_alert_paused_valid" CHECK ("SavedSearch"."OsmlsAlertPaused" IS NULL OR "SavedSearch"."OsmlsAlertPaused" IN ('failed', 'uncertain'));