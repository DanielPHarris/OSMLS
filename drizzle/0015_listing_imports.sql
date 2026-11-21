CREATE TABLE "OsmlsImport" (
	"ImportKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"SourceName" text NOT NULL,
	"Source" text NOT NULL,
	"FileName" text NOT NULL,
	"FileHash" text NOT NULL,
	"State" text DEFAULT 'Previewed' NOT NULL,
	"CreatedByMemberKey" uuid NOT NULL,
	"OriginalEntryTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"CommittedByMemberKey" uuid,
	"CommittedTimestamp" timestamp with time zone,
	CONSTRAINT "OsmlsImport_State_valid" CHECK ("State" IN ('Previewed', 'Committed')),
	CONSTRAINT "OsmlsImport_committed_by_someone" CHECK (("OsmlsImport"."State" = 'Committed') = ("OsmlsImport"."CommittedByMemberKey" IS NOT NULL) AND ("OsmlsImport"."State" = 'Committed') = ("OsmlsImport"."CommittedTimestamp" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "OsmlsImportRow" (
	"ImportKey" uuid NOT NULL,
	"RowNumber" integer NOT NULL,
	"Source" text NOT NULL,
	"SourceListingId" text NOT NULL,
	"Outcome" text NOT NULL,
	"Reasons" jsonb NOT NULL,
	"Content" jsonb,
	"ListingKey" uuid,
	CONSTRAINT "OsmlsImportRow_ImportKey_RowNumber_pk" PRIMARY KEY("ImportKey","RowNumber"),
	CONSTRAINT "OsmlsImportRow_Outcome_valid" CHECK ("Outcome" IN ('Accepted', 'Refused', 'Duplicate'))
);
--> statement-breakpoint
ALTER TABLE "OsmlsImport" ADD CONSTRAINT "OsmlsImport_CreatedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("CreatedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsImport" ADD CONSTRAINT "OsmlsImport_CommittedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("CommittedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsImportRow" ADD CONSTRAINT "OsmlsImportRow_ImportKey_OsmlsImport_ImportKey_fk" FOREIGN KEY ("ImportKey") REFERENCES "public"."OsmlsImport"("ImportKey") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsImportRow" ADD CONSTRAINT "OsmlsImportRow_ListingKey_Property_ListingKey_fk" FOREIGN KEY ("ListingKey") REFERENCES "public"."Property"("ListingKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "OsmlsImportRow_source_once" ON "OsmlsImportRow" USING btree ("Source","SourceListingId") WHERE "OsmlsImportRow"."ListingKey" IS NOT NULL;--> statement-breakpoint
-- Whoever could already manage staff could grant this to themselves, so they start with it.
UPDATE "Member" SET "OsmlsCapabilities" = array_append("OsmlsCapabilities", 'imports') WHERE 'staff' = ANY("OsmlsCapabilities") AND NOT 'imports' = ANY("OsmlsCapabilities");
