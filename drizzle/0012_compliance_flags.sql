CREATE TABLE "OsmlsFlag" (
	"FlagKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ListingKey" uuid NOT NULL,
	"RaisedByMemberKey" uuid NOT NULL,
	"Category" text NOT NULL,
	"Description" text NOT NULL,
	"State" text DEFAULT 'Open' NOT NULL,
	"RaisedTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"RaisedDate" date NOT NULL,
	"ClosedByMemberKey" uuid,
	"ClosedTimestamp" timestamp with time zone,
	"ClosingNote" text,
	CONSTRAINT "OsmlsFlag_Category_valid" CHECK ("Category" IN ('Incorrect information', 'Photos', 'Remarks', 'Status not updated', 'Duplicate listing', 'Market time or relisting link', 'Other')),
	CONSTRAINT "OsmlsFlag_State_valid" CHECK ("State" IN ('Open', 'Resolved', 'Dismissed')),
	CONSTRAINT "OsmlsFlag_Description_present" CHECK (length(trim("OsmlsFlag"."Description")) > 0),
	CONSTRAINT "OsmlsFlag_closed_with_details" CHECK (("OsmlsFlag"."State" = 'Open') = ("OsmlsFlag"."ClosedByMemberKey" IS NULL) AND ("OsmlsFlag"."State" = 'Open') = ("OsmlsFlag"."ClosedTimestamp" IS NULL) AND ("OsmlsFlag"."State" = 'Open' OR length(trim("OsmlsFlag"."ClosingNote")) > 0))
);
--> statement-breakpoint
CREATE TABLE "OsmlsRelistingLink" (
	"ListingKey" uuid PRIMARY KEY NOT NULL,
	"PredecessorKey" uuid,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "OsmlsRelistingLink_not_itself" CHECK ("OsmlsRelistingLink"."PredecessorKey" IS NULL OR "OsmlsRelistingLink"."PredecessorKey" <> "OsmlsRelistingLink"."ListingKey")
);
--> statement-breakpoint
ALTER TABLE "OsmlsFlag" ADD CONSTRAINT "OsmlsFlag_ListingKey_Property_ListingKey_fk" FOREIGN KEY ("ListingKey") REFERENCES "public"."Property"("ListingKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsFlag" ADD CONSTRAINT "OsmlsFlag_RaisedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("RaisedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsFlag" ADD CONSTRAINT "OsmlsFlag_ClosedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("ClosedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsRelistingLink" ADD CONSTRAINT "OsmlsRelistingLink_ListingKey_Property_ListingKey_fk" FOREIGN KEY ("ListingKey") REFERENCES "public"."Property"("ListingKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsRelistingLink" ADD CONSTRAINT "OsmlsRelistingLink_PredecessorKey_Property_ListingKey_fk" FOREIGN KEY ("PredecessorKey") REFERENCES "public"."Property"("ListingKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "OsmlsFlag_one_open" ON "OsmlsFlag" USING btree ("RaisedByMemberKey","ListingKey","Category") WHERE "OsmlsFlag"."State" = 'Open';--> statement-breakpoint
CREATE INDEX "OsmlsFlag_listing" ON "OsmlsFlag" USING btree ("ListingKey");--> statement-breakpoint
CREATE INDEX "OsmlsFlag_raised_by_date" ON "OsmlsFlag" USING btree ("RaisedByMemberKey","RaisedDate");--> statement-breakpoint
-- Whoever could already manage staff could grant this to themselves, so they start with it.
UPDATE "Member" SET "OsmlsCapabilities" = array_append("OsmlsCapabilities", 'compliance') WHERE 'staff' = ANY("OsmlsCapabilities") AND NOT 'compliance' = ANY("OsmlsCapabilities");
