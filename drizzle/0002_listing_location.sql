ALTER TABLE "Property" ADD COLUMN "Latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "Property" ADD COLUMN "Longitude" numeric(9, 6);--> statement-breakpoint
CREATE INDEX "Property_location_idx" ON "Property" USING btree ("Latitude","Longitude");--> statement-breakpoint
ALTER TABLE "Property" ADD CONSTRAINT "Property_Latitude_range" CHECK ("Property"."Latitude" BETWEEN -90 AND 90);--> statement-breakpoint
ALTER TABLE "Property" ADD CONSTRAINT "Property_Longitude_range" CHECK ("Property"."Longitude" BETWEEN -180 AND 180);--> statement-breakpoint
ALTER TABLE "Property" ADD CONSTRAINT "Property_location_both_or_neither" CHECK (("Property"."Latitude" IS NULL) = ("Property"."Longitude" IS NULL));