import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ListingForm } from "@/components/listing-form";
import { PhotoManager } from "@/components/photo-manager";
import { canEdit, getListing } from "@/lib/listings";
import { PROPERTY_TYPES, STANDARD_STATUSES, type StandardStatus } from "@/lib/lookups";
import { STATUS_TRANSITIONS, isTerminal } from "@/lib/rules/status";
import { requireMember } from "@/lib/session";

export default async function EditListingPage({ params }: { params: Promise<{ key: string }> }) {
  const current = await requireMember();
  const found = await getListing((await params).key);
  if (!found) notFound();
  const { listing, photos } = found;
  const status = listing.StandardStatus as StandardStatus;
  const isStaff = current.OsmlsRole === "staff";
  if (!canEdit(current, listing) || (!isStaff && isTerminal(status))) redirect(`/listings/${listing.ListingKey}`);

  const initial: Record<string, string> = {};
  for (const [k, v] of Object.entries(listing)) if (v != null && typeof v !== "object") initial[k] = String(v);

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/listings/${listing.ListingKey}`} className="text-sm text-brand">
          ← Back to listing
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          {isStaff ? "Correct" : "Edit"} listing {listing.ListingId}
        </h1>
        <p className="text-sm text-muted">{listing.UnparsedAddress}</p>
      </div>
      <ListingForm
        listingKey={listing.ListingKey}
        initial={initial}
        statusOptions={isStaff ? STANDARD_STATUSES : [status, ...STATUS_TRANSITIONS[status]]}
        propertyTypes={PROPERTY_TYPES}
        isStaffCorrection={isStaff}
        cancelHref={`/listings/${listing.ListingKey}`}
      />
      <PhotoManager
        listingKey={listing.ListingKey}
        photos={photos.map((p) => ({ MediaKey: p.MediaKey, Order: p.Order }))}
        isStaffCorrection={isStaff}
      />
    </div>
  );
}
