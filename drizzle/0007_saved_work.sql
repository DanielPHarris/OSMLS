CREATE TABLE "OsmlsCollection" (
	"CollectionKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"MemberKey" uuid NOT NULL,
	"CollectionName" text NOT NULL,
	"OriginalEntryTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "OsmlsCollection_name_not_blank" CHECK ("OsmlsCollection"."CollectionName" IS NOT NULL AND length(trim("OsmlsCollection"."CollectionName")) > 0)
);
--> statement-breakpoint
CREATE TABLE "OsmlsCollectionListing" (
	"CollectionKey" uuid NOT NULL,
	"ListingKey" uuid NOT NULL,
	"AddedTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"AddedSequence" bigserial NOT NULL,
	CONSTRAINT "OsmlsCollectionListing_CollectionKey_ListingKey_pk" PRIMARY KEY("CollectionKey","ListingKey")
);
--> statement-breakpoint
CREATE TABLE "SavedSearch" (
	"SavedSearchKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"MemberKey" uuid NOT NULL,
	"SavedSearchName" text NOT NULL,
	"ResourceName" text DEFAULT 'Property' NOT NULL,
	"OsmlsCriteria" jsonb NOT NULL,
	"SearchQueryHumanReadable" text NOT NULL,
	"OriginalEntryTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "SavedSearch_name_not_blank" CHECK ("SavedSearch"."SavedSearchName" IS NOT NULL AND length(trim("SavedSearch"."SavedSearchName")) > 0)
);
--> statement-breakpoint
ALTER TABLE "OsmlsCollection" ADD CONSTRAINT "OsmlsCollection_MemberKey_Member_MemberKey_fk" FOREIGN KEY ("MemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsCollectionListing" ADD CONSTRAINT "OsmlsCollectionListing_CollectionKey_OsmlsCollection_CollectionKey_fk" FOREIGN KEY ("CollectionKey") REFERENCES "public"."OsmlsCollection"("CollectionKey") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OsmlsCollectionListing" ADD CONSTRAINT "OsmlsCollectionListing_ListingKey_Property_ListingKey_fk" FOREIGN KEY ("ListingKey") REFERENCES "public"."Property"("ListingKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_MemberKey_Member_MemberKey_fk" FOREIGN KEY ("MemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "OsmlsCollection_member_name_unique" ON "OsmlsCollection" USING btree ("MemberKey",lower("CollectionName"));--> statement-breakpoint
CREATE UNIQUE INDEX "SavedSearch_member_name_unique" ON "SavedSearch" USING btree ("MemberKey",lower("SavedSearchName"));