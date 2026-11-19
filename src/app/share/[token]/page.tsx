import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportListing } from "@/components/report-view";
import { formatDate } from "@/lib/format";
import { localDate } from "@/lib/listings";
import { getSharedPage } from "@/lib/shares";

/*
 * The page behind a link a member gave a client. No account is needed: the link
 * is the permission. It draws only what getSharedPage hands it, which is the
 * client-safe data and nothing else.
 */

export const metadata: Metadata = { title: "Shared with you", robots: { index: false, follow: false } };

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const page = await getSharedPage((await params).token);
  // Unknown, expired, revoked, and suspended links all answer alike.
  if (!page) notFound();
  const { sharedBy, listings, notes } = page;
  const single = page.kind === "listing";
  return (
    <div className="card space-y-3" data-testid="shared-page">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold">Shared with you</h1>
        <p className="text-right text-sm" data-testid="shared-by">
          Shared by {sharedBy.name}
          {sharedBy.officeName && <span className="block">{sharedBy.officeName}</span>}
          {sharedBy.phone && <span className="block">{sharedBy.phone}</span>}
          <span className="block">{sharedBy.email}</span>
        </p>
      </header>
      {notes.length > 0 && (
        <ul className="rounded border border-line p-3 text-sm" data-testid="shared-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {listings.length > 0 ? (
        <div>
          {listings.map((listing) => (
            <ReportListing key={listing.ListingId} listing={listing} agent={null} single={single} />
          ))}
        </div>
      ) : (
        <p className="text-sm" data-testid="shared-unavailable">
          {single ? "This listing is not currently available." : "There are no listings to show right now."} Contact{" "}
          {sharedBy.name} for more information.
        </p>
      )}
      <p className="text-xs text-muted">
        Information is believed to be reliable but is not guaranteed. Listings are shown as they are today. This link
        works until {formatDate(localDate(page.expires))}.
      </p>
    </div>
  );
}
