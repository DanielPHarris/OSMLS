import type { StandardStatus } from "../lookups";

/*
 * Operating rules for listing status. An MLS adopting OSMLS is expected to edit
 * this file to match its own rules.
 */

/** Statuses a listing agent may choose when entering a new listing. */
export const INITIAL_STATUSES: readonly StandardStatus[] = ["Coming Soon", "Active"];

/** The status changes a listing agent may make. MLS staff corrections are not limited by this. */
export const STATUS_TRANSITIONS: Record<StandardStatus, readonly StandardStatus[]> = {
  "Coming Soon": ["Active", "Withdrawn", "Canceled"],
  Active: ["Active Under Contract", "Pending", "Hold", "Withdrawn", "Canceled", "Expired"],
  "Active Under Contract": ["Active", "Pending", "Withdrawn", "Canceled"],
  Pending: ["Active", "Closed", "Withdrawn", "Canceled"],
  Hold: ["Active", "Withdrawn", "Canceled", "Expired"],
  Withdrawn: ["Active", "Canceled", "Expired"],
  Closed: [],
  Canceled: [],
  Expired: [],
};

export function canTransition(from: StandardStatus, to: StandardStatus): boolean {
  return from === to || STATUS_TRANSITIONS[from].includes(to);
}

/** A listing in a terminal status can only be changed by an MLS staff correction. */
export function isTerminal(status: StandardStatus): boolean {
  return STATUS_TRANSITIONS[status].length === 0;
}

/**
 * The statuses in which any active member may read a listing's showing
 * instructions. In every other status, including any added later, only the
 * listing agent, the listing office, and MLS staff may.
 */
export const SHOWING_OPEN_TO_MEMBERS_STATUSES: readonly StandardStatus[] = [
  "Coming Soon",
  "Active",
  "Active Under Contract",
  "Pending",
  "Hold",
  "Withdrawn",
];

const OFF_MARKET_BUT_OPEN: readonly StandardStatus[] = [
  "Active Under Contract",
  "Pending",
  "Hold",
  "Withdrawn",
];

/** The Data Dictionary ChangeType recorded in history for a status change. */
export function changeTypeForStatus(from: StandardStatus, to: StandardStatus): string {
  if (to === "Active" && OFF_MARKET_BUT_OPEN.includes(from)) return "Back On Market";
  return to;
}
