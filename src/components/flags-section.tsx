import { ActionForm } from "@/components/action-form";
import { closeFlagAction, raiseFlagAction, setRelistingLinkAction } from "@/app/compliance-actions";
import type { FlagDetail, FlagSummary, RelistingLinkView } from "@/lib/compliance";
import { formatDateTime } from "@/lib/format";
import { FLAG_CATEGORIES } from "@/lib/lookups";
import { MAX_FLAG_TEXT_LENGTH } from "@/lib/rules/local";

/**
 * Flags on a listing. Everyone signed in can raise one. What is listed depends
 * on the viewer and is decided in src/lib/compliance.ts: `staffFlags` is given
 * only for compliance staff, and is the only thing here that says who raised a
 * flag.
 */
export function FlagsSection({
  listingKey,
  flags,
  staffFlags,
  listingSide,
}: {
  listingKey: string;
  flags: FlagSummary[];
  staffFlags: FlagDetail[] | null;
  listingSide: boolean;
}) {
  const shown: (FlagSummary & Partial<FlagDetail>)[] = staffFlags ?? flags;
  return (
    <section className="card space-y-4 print:hidden" aria-labelledby="flags-heading" data-testid="flags">
      <h2 id="flags-heading" className="text-base font-semibold">
        Flags
      </h2>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">
          {staffFlags || listingSide ? "No flags have been raised on this listing." : "You have raised no flags on this listing."}
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {shown.map((f) => (
            <li key={f.flagKey} className="space-y-1 py-3" data-testid="flag">
              <p className="font-medium">
                {f.category} · <span data-testid="flag-state">{f.state}</span>
              </p>
              <p className="whitespace-pre-wrap">{f.description}</p>
              <p className="text-xs text-muted">
                Raised {formatDateTime(f.raisedAt)}
                {f.raisedBy
                  ? ` by ${f.raisedBy.name} (${f.raisedBy.memberId}${f.raisedBy.officeName ? `, ${f.raisedBy.officeName}` : ""})`
                  : f.mine
                    ? " by you"
                    : ""}
              </p>
              {f.state !== "Open" && (
                <p data-testid="flag-closing-note">
                  {f.state} {f.closedAt ? formatDateTime(f.closedAt) : ""}
                  {f.closedBy ? ` by ${f.closedBy}` : ""}: {f.closingNote}
                </p>
              )}
              {staffFlags && f.state === "Open" && (
                <ActionForm action={closeFlagAction.bind(null, f.flagKey)} className="mt-2 space-y-2">
                  <label className="label block">
                    Closing note
                    <textarea name="note" required maxLength={MAX_FLAG_TEXT_LENGTH} rows={2} className="field w-full" />
                    <span className="text-xs font-normal text-muted">
                      The member who raised the flag and the listing agent&rsquo;s office will read this.
                    </span>
                  </label>
                  <div className="flex gap-2">
                    <button name="state" value="Resolved" className="btn">
                      Resolve
                    </button>
                    <button name="state" value="Dismissed" className="btn-secondary">
                      Dismiss
                    </button>
                  </div>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium text-brand">Flag a problem with this listing</summary>
        <ActionForm action={raiseFlagAction.bind(null, listingKey)} className="mt-3 space-y-3">
          <label className="label">
            What is it about?
            <select name="category" required defaultValue="" className="field">
              <option value="" disabled>
                Choose
              </option>
              {FLAG_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="label block">
            Describe the problem
            <textarea name="description" required maxLength={MAX_FLAG_TEXT_LENGTH} rows={3} className="field w-full" />
            <span className="text-xs font-normal text-muted">
              MLS staff review flags. The listing agent and their office can read what you write here, but are not told
              who raised it, so leave out anything that identifies you if you do not want them to know. A flag changes
              nothing about the listing by itself.
            </span>
          </label>
          <button className="btn">Raise flag</button>
        </ActionForm>
      </details>
    </section>
  );
}

/** For compliance staff: which earlier listing this one continues. */
export function RelistingLinkSection({ listingKey, link }: { listingKey: string; link: RelistingLinkView }) {
  return (
    <section className="card space-y-3 print:hidden" aria-labelledby="link-heading" data-testid="relisting-link">
      <h2 id="link-heading" className="text-base font-semibold">
        Earlier listing:{" "}
        <span data-testid="relisting-link-current">
          {link.mode === "automatic" ? "chosen automatically" : link.mode === "none" ? "none" : `listing ${link.listingId}`}
        </span>
      </h2>
      <p className="text-sm text-muted">
        Cumulative days on market follows the earlier listing of the same property. It is found by parcel number and
        address, which can link unrelated listings or miss a real relisting. Naming a listing here settles only that it
        is the same property: the relisting gap, the brokerage rule, and how the earlier listing ended still decide
        whether the count continues, and a link is never followed past a sale of the property.
      </p>
      <ActionForm action={setRelistingLinkAction.bind(null, listingKey)} className="space-y-3">
        <fieldset className="space-y-1 text-sm">
          <legend className="label">This listing continues</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="automatic" defaultChecked={link.mode === "automatic"} />
            Whatever matching finds (automatic)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="none" defaultChecked={link.mode === "none"} />
            No earlier listing
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="named" defaultChecked={link.mode === "named"} />
            This listing:
          </label>
        </fieldset>
        <label className="label">
          Listing number of the earlier listing
          <input name="listingId" maxLength={20} defaultValue={link.listingId ?? ""} className="field" />
        </label>
        <label className="label block">
          Reason
          <textarea name="reason" required maxLength={500} rows={2} className="field w-full" />
        </label>
        <button className="btn">Save earlier listing</button>
      </ActionForm>
    </section>
  );
}
