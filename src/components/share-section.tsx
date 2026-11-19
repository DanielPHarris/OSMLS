import { revokeShareAction, shareAction } from "@/app/share-actions";
import { formatDateTime } from "@/lib/format";
import { mailEnabled } from "@/lib/mail";
import { DEFAULT_SHARE_EXPIRY_DAYS, MAX_SHARE_NOTE_LENGTH, SHARE_EXPIRY_DAYS } from "@/lib/rules/local";
import { listShares, type ShareTarget } from "@/lib/shares";
import type { Member } from "@/db/schema";
import { ActionForm } from "./action-form";
import { ShareForm } from "./share-form";

/** Making, listing, and revoking the viewer's own links to one listing or collection. */
export async function ShareSection({
  viewer,
  target,
  refusal,
}: {
  viewer: Member;
  target: ShareTarget;
  /** Why this cannot be shared right now, if it cannot. */
  refusal?: string;
}) {
  const shares = await listShares(viewer, target);
  const collection = "collection" in target;
  return (
    <section className="card space-y-3" aria-labelledby="share-heading" data-testid="shares">
      <h2 id="share-heading" className="text-base font-semibold">
        Share with a client
      </h2>
      <p className="text-sm text-muted">
        A link opens a page with the client copy of {collection ? "the listings in this collection" : "this listing"}, without
        an account. Anyone holding the link can open it until it expires or you revoke it.
      </p>
      {collection && (
        <p className="text-sm" data-testid="share-warning">
          {shares.length > 0 && (
            <strong>
              This collection is shared through {shares.length} {shares.length === 1 ? "link" : "links"}.{" "}
            </strong>
          )}
          A link shows what is in the collection when it is opened, not when it was made. Listings you add later become
          visible to anyone holding a link.
        </p>
      )}
      {refusal ? (
        <p className="text-sm">{refusal}</p>
      ) : (
        <ShareForm
          action={shareAction.bind(null, target)}
          expiryDays={SHARE_EXPIRY_DAYS}
          defaultDays={DEFAULT_SHARE_EXPIRY_DAYS}
          maxNoteLength={MAX_SHARE_NOTE_LENGTH}
          emailEnabled={mailEnabled()}
        />
      )}
      {shares.length > 0 && (
        <ul className="divide-y divide-line" data-testid="share-list">
          {shares.map((s) => (
            <li key={s.ShareKey} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
              <span>
                {s.OsmlsRecipientEmail
                  ? `Emailed to ${s.OsmlsRecipientEmail}`
                  : s.OsmlsSentTimestamp
                    ? "Emailed; the recipient asked for no more email, so the address is not kept"
                    : "Link, not emailed"}{" "}
                · made {formatDateTime(s.OriginalEntryTimestamp)} · works until {formatDateTime(s.ExpirationTimestamp)}
              </span>
              <ActionForm action={revokeShareAction.bind(null, s.ShareKey)} className="flex items-center gap-3">
                <button className="btn-secondary !px-3 !py-1">Revoke</button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
