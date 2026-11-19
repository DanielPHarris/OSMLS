import type { Member, Property } from "../db/schema";
import type { DocumentPermission } from "./lookups";
import { SHOWING_OPEN_TO_MEMBERS_STATUSES } from "./rules/status";

/*
 * Who may read restricted listing content. These two functions are the only
 * place the rules are written; every screen and route asks them.
 *
 * Each rule names who is allowed. Anyone it does not name is refused.
 */

export type Viewer = Pick<Member, "MemberKey" | "OfficeKey" | "OsmlsRole" | "MemberStatus"> | null;
export type ListingSide = Pick<Property, "ListAgentKey" | "ListOfficeKey" | "StandardStatus">;

/** An inactive (suspended) account can do nothing, whatever its role. */
export const isActive = (viewer: Viewer): viewer is NonNullable<Viewer> =>
  viewer != null && viewer.MemberStatus === "Active";

/** MLS staff: an active account that affirmatively holds the staff role. */
export const isStaff = (viewer: Viewer): boolean => isActive(viewer) && viewer.OsmlsRole === "staff";

const isListingAgent = (viewer: Viewer, listing: ListingSide): boolean =>
  isActive(viewer) && viewer.OsmlsRole === "agent" && viewer.MemberKey === listing.ListAgentKey;

/** An agent in the one office named on the listing (not the whole brokerage). */
const isInListingOffice = (viewer: Viewer, listing: ListingSide): boolean =>
  isActive(viewer) &&
  viewer.OsmlsRole === "agent" &&
  viewer.OfficeKey != null &&
  viewer.OfficeKey === listing.ListOfficeKey;

const isAgent = (viewer: Viewer): boolean => isActive(viewer) && viewer.OsmlsRole === "agent";

/*
 * Saved work belongs to the member who made it. No one else may read or change
 * it: not a colleague in the same office, and not MLS staff. Staff have saved
 * work of their own on the same terms.
 */
const ownsSavedWork = (viewer: Viewer, ownerMemberKey: string): boolean =>
  isActive(viewer) && viewer.MemberKey === ownerMemberKey;

export const canUseSavedSearch = (viewer: Viewer, savedSearch: { MemberKey: string }): boolean =>
  ownsSavedWork(viewer, savedSearch.MemberKey);

export const canUseCollection = (viewer: Viewer, collection: { MemberKey: string }): boolean =>
  ownsSavedWork(viewer, collection.MemberKey);

export function canViewDocument(
  viewer: Viewer,
  listing: ListingSide,
  permission: DocumentPermission | string | null,
): boolean {
  if (isStaff(viewer)) return true;
  switch (permission) {
    case "Private":
      return isAgent(viewer);
    case "Office Only":
      return isListingAgent(viewer, listing) || isInListingOffice(viewer, listing);
    case "Agent Only":
      return isListingAgent(viewer, listing);
    default:
      // An unknown or missing permission admits no one but staff.
      return false;
  }
}

export function canViewShowing(viewer: Viewer, listing: ListingSide): boolean {
  if (isStaff(viewer)) return true;
  if (isListingAgent(viewer, listing) || isInListingOffice(viewer, listing)) return true;
  return (
    isAgent(viewer) &&
    (SHOWING_OPEN_TO_MEMBERS_STATUSES as readonly string[]).includes(listing.StandardStatus)
  );
}
