import { redirect } from "next/navigation";
import { ListingForm } from "@/components/listing-form";
import { PROPERTY_TYPES } from "@/lib/lookups";
import { INITIAL_STATUSES } from "@/lib/rules/status";
import { requireMember } from "@/lib/session";

export default async function NewListingPage() {
  const current = await requireMember();
  if (current.OsmlsRole !== "agent") redirect("/search");
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">New listing</h1>
      <ListingForm
        listingKey={null}
        initial={{ StandardStatus: "Active", PropertyType: "Residential", ListingContractDate: new Date().toISOString().slice(0, 10) }}
        statusOptions={INITIAL_STATUSES}
        propertyTypes={PROPERTY_TYPES}
        isStaffCorrection={false}
        cancelHref="/search"
      />
    </>
  );
}
