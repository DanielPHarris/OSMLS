ALTER TABLE "Media" ADD COLUMN "Permission" text;--> statement-breakpoint
ALTER TABLE "Media" ADD COLUMN "OsmlsFileSize" integer;--> statement-breakpoint
ALTER TABLE "Media" ADD COLUMN "OsmlsFileHash" text;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "ShowingInstructions" text;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "ShowingRequirements" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "ShowingContactName" text;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "ShowingContactPhone" text;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "ShowingContactType" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "LockBoxType" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "LockBoxLocation" text;--> statement-breakpoint
ALTER TABLE "Media" ADD CONSTRAINT "Media_MediaCategory_valid" CHECK ("MediaCategory" IN ('Photo', 'Document'));--> statement-breakpoint
ALTER TABLE "Media" ADD CONSTRAINT "Media_Permission_valid" CHECK ("Permission" IN ('Agent Only', 'Office Only', 'Private'));--> statement-breakpoint
ALTER TABLE "Media" ADD CONSTRAINT "Media_document_is_complete" CHECK ("Media"."MediaCategory" <> 'Document' OR ("Media"."Permission" IS NOT NULL AND length(trim("Media"."ShortDescription")) > 0 AND "Media"."OsmlsFileHash" IS NOT NULL AND "Media"."OsmlsFileSize" IS NOT NULL));