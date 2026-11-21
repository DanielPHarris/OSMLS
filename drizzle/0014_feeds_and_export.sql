CREATE TABLE "OsmlsExport" (
	"ExportKey" bigserial PRIMARY KEY NOT NULL,
	"MemberKey" uuid NOT NULL,
	"ExportTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"Kind" text NOT NULL,
	"Criteria" jsonb NOT NULL,
	"ListingCount" integer NOT NULL,
	"OmittedForStatus" integer NOT NULL,
	"SearchCutOff" boolean NOT NULL,
	CONSTRAINT "OsmlsExport_Kind_valid" CHECK ("Kind" IN ('agent', 'client'))
);
--> statement-breakpoint
ALTER TABLE "OsmlsDataConsumer" ADD COLUMN "Feed" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "OsmlsDataRequest" ADD COLUMN "Feed" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "OsmlsExport" ADD CONSTRAINT "OsmlsExport_MemberKey_Member_MemberKey_fk" FOREIGN KEY ("MemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "OsmlsExport_member" ON "OsmlsExport" USING btree ("MemberKey","ExportTimestamp");--> statement-breakpoint
ALTER TABLE "OsmlsDataConsumer" ADD CONSTRAINT "OsmlsDataConsumer_Feed_valid" CHECK ("Feed" IN ('full', 'public'));