ALTER TABLE "Property" ADD COLUMN "CountyOrParish" text;--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "ParcelNumber" text;--> statement-breakpoint
CREATE INDEX "Property_ParcelNumber_idx" ON "Property" USING btree ("ParcelNumber");--> statement-breakpoint
CREATE INDEX "Property_CloseDate_idx" ON "Property" USING btree ("CloseDate");