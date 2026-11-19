import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ListingForm } from "@/components/listing-form";
import { DocumentManager } from "@/components/document-manager";
import { PhotoManager } from "@/components/photo-manager";
import { formatFileSize, formatFileType } from "@/lib/format";
import { canEdit, getListing } from "@/lib/listings";
import {
  DEFAULT_DOCUMENT_PERMISSION,
  DOCUMENT_PERMISSIONS,
  DOCUMENT_PERMISSION_LABELS,
  LOCK_BOX_TYPES,
  PROPERTY_TYPES,
  SHOWING_CONTACT_TYPES,
  SHOWING_REQUIREMENTS,
  STANDARD_STATUSES,
  type DocumentPermission,
  type StandardStatus,
} from "@/lib/lookups";
import { getMapConfig } from "@/lib/map-config";
import { STATUS_TRANSITIONS, isTerminal } from "@/lib/rules/status";
import { requireMember } from "@/lib/session";

export default async function EditListingPage({ params }: { params: Promise<{ key: string }> }) {
  const current = await requireMember();
  const found = await getListing((await params).key, current);
  if (!found) notFound();
  const { listing, photos, documents } = found;
  const status = listing.StandardStatus as StandardStatus;
  const isStaff = current.OsmlsRole === "staff";
  if (!canEdit(current, listing) || (!isStaff && isTerminal(status))) redirect(`/listings/${listing.ListingKey}`);

  const initial: Record<string, string> = {};
  for (const [k, v] of Object.entries(listing)) {
    if (Array.isArray(v)) initial[k] = v.join("|");
    else if (v != null && typeof v !== "object") initial[k] = String(v);
  }

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
        mapConfig={getMapConfig()}
        showingChoices={{ requirements: SHOWING_REQUIREMENTS, contactTypes: SHOWING_CONTACT_TYPES, lockBoxTypes: LOCK_BOX_TYPES }}
      />
      <DocumentManager
        listingKey={listing.ListingKey}
        documents={documents.map((d) => ({
          MediaKey: d.MediaKey,
          name: d.ShortDescription ?? "",
          permission: d.Permission ?? DEFAULT_DOCUMENT_PERMISSION,
          type: formatFileType(d.MediaType),
          size: formatFileSize(d.OsmlsFileSize),
        }))}
        permissions={DOCUMENT_PERMISSIONS.map((p) => ({ value: p, label: DOCUMENT_PERMISSION_LABELS[p as DocumentPermission] }))}
        defaultPermission={DEFAULT_DOCUMENT_PERMISSION}
        isStaffCorrection={isStaff}
      />
      <PhotoManager
        listingKey={listing.ListingKey}
        photos={photos.map((p) => ({ MediaKey: p.MediaKey, Order: p.Order }))}
        isStaffCorrection={isStaff}
      />
    </div>
  );
}
