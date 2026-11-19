import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { getActivity, type ActivityEvent, type ActivityListing } from "@/lib/activity";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { MAX_ACTIVITY_LISTINGS } from "@/lib/rules/local";
import { requireMember } from "@/lib/session";
import { markActivitySeenAction } from "../../../saved-work-actions";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(event: ActivityEvent, listing: ActivityListing): string {
  if (event.kind === "new") return `New listing, entered as ${event.next}`;
  if (event.kind === "price") return `List price ${formatMoney(Number(event.previous))} → ${formatMoney(Number(event.next))}`;
  const closing =
    event.next === "Closed" && listing.ClosePrice != null
      ? ` (closed at ${formatMoney(listing.ClosePrice)} on ${formatDate(listing.CloseDate)})`
      : "";
  return `Status ${event.previous} → ${event.next}${closing}`;
}

function Listings({ listings, testId }: { listings: ActivityListing[]; testId: string }) {
  return (
    <ul className="card divide-y divide-line !p-0" data-testid={testId}>
      {listings.map((listing) => (
        <li key={listing.ListingKey} className="p-4" data-testid="activity-listing">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <p>
              <Link href={`/listings/${listing.ListingKey}`} className="font-medium text-brand underline">
                {listing.ListingId}
              </Link>{" "}
              {listing.UnparsedAddress}
            </p>
            <p className="text-sm text-muted">
              {listing.StandardStatus} · {formatMoney(listing.ListPrice)} · {listing.agentName}, {listing.officeName}
            </p>
          </div>
          <ul className="mt-1 text-sm">
            {listing.omittedEvents > 0 && (
              <li className="text-muted" data-testid="omitted-events">
                {plural(listing.omittedEvents, "earlier change")} not shown.
              </li>
            )}
            {listing.events.map((event, i) => (
              <li key={i}>
                {describe(event, listing)} <span className="text-muted">· {formatDateTime(event.at)}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export default async function ActivityPage({ params }: { params: Promise<{ key: string }> }) {
  const current = await requireMember();
  const { key } = await params;
  // Null for someone else's saved search and for one that does not exist alike.
  // Reading activity never marks it as seen: only the button below does.
  const activity = await getActivity(current, key);
  if (!activity) notFound();
  const { savedSearch, matching, mayNoLongerMatch, moreListings, ignored } = activity;
  const shown = [...matching, ...mayNoLongerMatch];
  const omittedEvents = shown.reduce((sum, l) => sum + l.omittedEvents, 0);
  // Everything marking as seen would clear that this page does not show.
  const unseenToo = [
    ...(moreListings ? ["listings with activity that are not shown on this page"] : []),
    ...(omittedEvents > 0 ? [`${plural(omittedEvents, "earlier change")} left out of the listings shown`] : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/saved-searches" className="text-sm text-brand">
          ← Saved searches
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Activity: {savedSearch.SavedSearchName}</h1>
        <p className="text-sm text-muted">{savedSearch.SearchQueryHumanReadable}</p>
        <p className="mt-2 text-sm" data-testid="activity-since">
          New listings, status changes, and list price changes since {formatDateTime(savedSearch.OsmlsActivitySeenAt)}. That
          is when this search was saved, its criteria were last changed, or its activity was last marked as seen,
          whichever came last. Changes to anything else are not activity.
        </p>
        {ignored.length > 0 && (
          <p role="status" className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900" data-testid="ignored-criteria">
            Some of what this search was saved with is no longer available and was ignored: {ignored.join(", ")}.
          </p>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="card text-sm text-muted" data-testid="no-activity">
          Nothing new since then.
        </p>
      ) : (
        <>
          <div className="card space-y-2" data-testid="mark-seen">
            {moreListings && (
              <p className="text-sm" data-testid="more-listings">
                Showing the {MAX_ACTIVITY_LISTINGS} most recently changed listings. More have activity than are shown
                here; how many was not counted.
              </p>
            )}
            <ActionForm action={markActivitySeenAction.bind(null, savedSearch.SavedSearchKey, activity.through)}>
              <button className="btn">{unseenToo.length > 0 ? "Mark all as seen, including what is not shown" : "Mark as seen"}</button>
            </ActionForm>
            <p className="text-xs text-muted" data-testid="mark-seen-note">
              {unseenToo.length > 0
                ? `This clears everything up to when this page was loaded, not only what you can see. It also clears: ${unseenToo.join("; and ")}.`
                : "This clears what is shown here. Anything that changed after this page was loaded stays."}
            </p>
          </div>

          {matching.length > 0 && (
            <section className="space-y-2" aria-labelledby="matching-heading">
              <h2 id="matching-heading" className="text-base font-semibold">
                Matching this search now ({matching.length})
              </h2>
              <Listings listings={matching} testId="activity-matching" />
            </section>
          )}
          {mayNoLongerMatch.length > 0 && (
            <section className="space-y-2" aria-labelledby="left-heading">
              <h2 id="left-heading" className="text-base font-semibold">
                May no longer match ({mayNoLongerMatch.length})
              </h2>
              <p className="text-sm text-muted" data-testid="may-no-longer-match-note">
                These listings do not match the search now, and would with their status and list price as they were at
                the time above. Only status and list price are taken from history. Everything else the search asks for
                is checked against the listing as it is today, so a listing whose bedrooms, address, or map location
                also changed can appear here without ever having matched, or be missing although it did.
              </p>
              <Listings listings={mayNoLongerMatch} testId="activity-may-no-longer-match" />
            </section>
          )}
        </>
      )}
      <p>
        <Link href={`/saved-searches/${savedSearch.SavedSearchKey}/run`} className="btn-secondary">
          Run this search
        </Link>
      </p>
    </div>
  );
}
