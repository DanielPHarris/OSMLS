CREATE SEQUENCE "public"."listing_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1000001 CACHE 1;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "HistoryTransactional" (
	"HistoryTransactionalKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ResourceName" text DEFAULT 'Property' NOT NULL,
	"ResourceRecordKey" uuid NOT NULL,
	"ResourceRecordID" text NOT NULL,
	"ClassName" text NOT NULL,
	"FieldName" text NOT NULL,
	"PreviousValue" text,
	"NewValue" text,
	"ChangeType" text,
	"ChangedByMemberKey" uuid NOT NULL,
	"ChangedByMemberID" text NOT NULL,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"OsmlsStaffCorrection" boolean DEFAULT false NOT NULL,
	"OsmlsCorrectionReason" text,
	CONSTRAINT "HistoryTransactional_correction_has_reason" CHECK (NOT "HistoryTransactional"."OsmlsStaffCorrection" OR length(trim("HistoryTransactional"."OsmlsCorrectionReason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "Media" (
	"MediaKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ResourceName" text DEFAULT 'Property' NOT NULL,
	"ResourceRecordKey" uuid NOT NULL,
	"MediaCategory" text DEFAULT 'Photo' NOT NULL,
	"MediaType" text NOT NULL,
	"Order" integer NOT NULL,
	"ShortDescription" text,
	"OsmlsStoragePath" text NOT NULL,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Member" (
	"MemberKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"MemberMlsId" text NOT NULL,
	"MemberFirstName" text NOT NULL,
	"MemberLastName" text NOT NULL,
	"MemberFullName" text NOT NULL,
	"MemberEmail" text NOT NULL,
	"MemberDirectPhone" text,
	"MemberStatus" text DEFAULT 'Active' NOT NULL,
	"OfficeKey" uuid,
	"OsmlsRole" text NOT NULL,
	"OsmlsUserId" text NOT NULL,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Member_MemberMlsId_unique" UNIQUE("MemberMlsId"),
	CONSTRAINT "Member_MemberEmail_unique" UNIQUE("MemberEmail"),
	CONSTRAINT "Member_OsmlsUserId_unique" UNIQUE("OsmlsUserId"),
	CONSTRAINT "Member_MemberStatus_valid" CHECK ("MemberStatus" IN ('Active', 'Inactive')),
	CONSTRAINT "Member_OsmlsRole_valid" CHECK ("OsmlsRole" IN ('agent', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "Office" (
	"OfficeKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"OfficeMlsId" text NOT NULL,
	"OfficeName" text NOT NULL,
	"MainOfficeKey" uuid,
	"OfficeStatus" text DEFAULT 'Active' NOT NULL,
	"OfficePhone" text,
	"OfficeCity" text,
	"OfficeStateOrProvince" text,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "Office_OfficeMlsId_unique" UNIQUE("OfficeMlsId")
);
--> statement-breakpoint
CREATE TABLE "Property" (
	"ListingKey" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ListingId" text DEFAULT 'OS' || nextval('listing_id_seq')::text NOT NULL,
	"StandardStatus" text NOT NULL,
	"PropertyType" text NOT NULL,
	"ListPrice" numeric(14, 2) NOT NULL,
	"OriginalListPrice" numeric(14, 2) NOT NULL,
	"ClosePrice" numeric(14, 2),
	"CloseDate" date,
	"ListingContractDate" date NOT NULL,
	"OnMarketDate" date,
	"StreetNumber" text NOT NULL,
	"StreetName" text NOT NULL,
	"UnitNumber" text,
	"City" text NOT NULL,
	"StateOrProvince" text NOT NULL,
	"PostalCode" text NOT NULL,
	"UnparsedAddress" text NOT NULL,
	"BedroomsTotal" integer NOT NULL,
	"BathroomsTotalInteger" integer NOT NULL,
	"LivingArea" integer,
	"LotSizeAcres" numeric(10, 3),
	"YearBuilt" integer,
	"PublicRemarks" text,
	"ListAgentKey" uuid NOT NULL,
	"ListOfficeKey" uuid NOT NULL,
	"OsmlsLocalFields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"OriginalEntryTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"ModificationTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"StatusChangeTimestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"PriceChangeTimestamp" timestamp with time zone,
	CONSTRAINT "Property_ListingId_unique" UNIQUE("ListingId"),
	CONSTRAINT "Property_StandardStatus_valid" CHECK ("StandardStatus" IN ('Active', 'Active Under Contract', 'Canceled', 'Closed', 'Coming Soon', 'Expired', 'Hold', 'Pending', 'Withdrawn')),
	CONSTRAINT "Property_PropertyType_valid" CHECK ("PropertyType" IN ('Residential', 'Residential Lease', 'Residential Income', 'Land', 'Farm', 'Manufactured In Park', 'Commercial Sale', 'Commercial Lease', 'Business Opportunity')),
	CONSTRAINT "Property_ListPrice_positive" CHECK ("Property"."ListPrice" > 0),
	CONSTRAINT "Property_BedroomsTotal_nonnegative" CHECK ("Property"."BedroomsTotal" >= 0),
	CONSTRAINT "Property_BathroomsTotalInteger_nonnegative" CHECK ("Property"."BathroomsTotalInteger" >= 0),
	CONSTRAINT "Property_Closed_has_price_and_date" CHECK ("Property"."StandardStatus" <> 'Closed' OR ("Property"."ClosePrice" IS NOT NULL AND "Property"."CloseDate" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "HistoryTransactional" ADD CONSTRAINT "HistoryTransactional_ChangedByMemberKey_Member_MemberKey_fk" FOREIGN KEY ("ChangedByMemberKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Media" ADD CONSTRAINT "Media_ResourceRecordKey_Property_ListingKey_fk" FOREIGN KEY ("ResourceRecordKey") REFERENCES "public"."Property"("ListingKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Member" ADD CONSTRAINT "Member_OfficeKey_Office_OfficeKey_fk" FOREIGN KEY ("OfficeKey") REFERENCES "public"."Office"("OfficeKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Member" ADD CONSTRAINT "Member_OsmlsUserId_user_id_fk" FOREIGN KEY ("OsmlsUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Property" ADD CONSTRAINT "Property_ListAgentKey_Member_MemberKey_fk" FOREIGN KEY ("ListAgentKey") REFERENCES "public"."Member"("MemberKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Property" ADD CONSTRAINT "Property_ListOfficeKey_Office_OfficeKey_fk" FOREIGN KEY ("ListOfficeKey") REFERENCES "public"."Office"("OfficeKey") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "HistoryTransactional_record_idx" ON "HistoryTransactional" USING btree ("ResourceRecordKey","ModificationTimestamp");--> statement-breakpoint
CREATE INDEX "Media_ResourceRecordKey_idx" ON "Media" USING btree ("ResourceRecordKey");--> statement-breakpoint
CREATE INDEX "Property_StandardStatus_idx" ON "Property" USING btree ("StandardStatus");--> statement-breakpoint
CREATE INDEX "Property_City_idx" ON "Property" USING btree ("City");--> statement-breakpoint
CREATE INDEX "Property_PostalCode_idx" ON "Property" USING btree ("PostalCode");--> statement-breakpoint
CREATE INDEX "Property_ListPrice_idx" ON "Property" USING btree ("ListPrice");--> statement-breakpoint
CREATE INDEX "Property_ListAgentKey_idx" ON "Property" USING btree ("ListAgentKey");