CREATE TABLE "OsmlsMarketTimeSettings" (
	"Version" integer PRIMARY KEY NOT NULL,
	"AccumulatingStatuses" text[] NOT NULL,
	"RelistingGapDays" integer NOT NULL,
	"BrokerageChangeResets" boolean NOT NULL,
	"AddressFallback" boolean NOT NULL,
	"GapEndpoint" text NOT NULL,
	"TimeZone" text NOT NULL,
	"ChangedByMemberKey" uuid,
	"Reason" text,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "OsmlsMarketTimeSettings_GapEndpoint_valid" CHECK ("GapEndpoint" IN ('entered', 'onMarket'))
);
--> statement-breakpoint
ALTER TABLE "Member" ADD COLUMN "OsmlsCapabilities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "OsmlsMarketTimeSettings" ADD CONSTRAINT "OsmlsMarketTimeSettings_ChangedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("ChangedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The first version: the values the application used while they were in code.
INSERT INTO "OsmlsMarketTimeSettings" ("Version", "AccumulatingStatuses", "RelistingGapDays", "BrokerageChangeResets", "AddressFallback", "GapEndpoint", "TimeZone")
VALUES (1, ARRAY['Active', 'Active Under Contract'], 30, false, true, 'entered', 'America/Los_Angeles');--> statement-breakpoint
-- Until now every staff account could administer everything, so each keeps all four capabilities.
UPDATE "Member" SET "OsmlsCapabilities" = ARRAY['members', 'offices', 'settings', 'staff'] WHERE "OsmlsRole" = 'staff';
