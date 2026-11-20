import type { StandardStatus } from "../lookups";

/*
 * How days on market are counted and when a relisting continues an earlier
 * listing's count. The Data Dictionary leaves both to each MLS, so these are
 * policy for each MLS to set, not a standard.
 *
 * The settings in force are kept in the database and changed on the Settings
 * screen by staff who hold "Manage settings" (src/lib/settings.ts). The values
 * below are only what a new installation starts with: the first stored version
 * is made from them, and the application never reads them after that.
 *
 * A change recalculates the past. The figures are worked out from each
 * listing's status history whenever they are shown, so a new value changes them
 * for old listings as well as new ones.
 */
export type MarketTimeSettings = {
  /**
   * The one list of statuses in which a listing gains days on market. In every
   * other status the count is paused. There is no separate list of pausing
   * statuses.
   */
  accumulatingStatuses: readonly StandardStatus[];
  /**
   * A relisting continues the earlier count only if fewer than this many days
   * passed between the earlier listing leaving the market and the gap endpoint.
   */
  relistingGapDays: number;
  /**
   * Whether a relisting taken by a different brokerage starts from zero. A
   * brokerage is a main office together with its branches; offices are never
   * compared directly.
   */
  brokerageChangeResets: boolean;
  /** Whether listings may be matched by address when a parcel match is not possible. */
  addressFallback: boolean;
  /** Where the gap ends: the date the new listing was entered, or the date it first went on the market. */
  gapEndpoint: "entered" | "onMarket";
  /** The time zone whose calendar dates are used for counting (an IANA name). */
  timeZone: string;
};

export const STARTING_MARKET_TIME_SETTINGS: MarketTimeSettings = {
  accumulatingStatuses: ["Active", "Active Under Contract"],
  relistingGapDays: 30,
  brokerageChangeResets: false,
  addressFallback: true,
  gapEndpoint: "entered",
  timeZone: "America/Los_Angeles",
};

/**
 * Statuses a listing must have ended in for a later listing to continue its
 * count. A sale is deliberately absent and is not a setting: it always resets.
 */
export const CONTINUABLE_END_STATUSES: readonly StandardStatus[] = ["Canceled", "Expired", "Withdrawn"];

/** Defaults for "Find comparables". The agent can change each one before searching. */
export const COMPARABLE_DEFAULTS = {
  closedWithinDays: 180,
  radiusMiles: 1,
  livingAreaPercent: 20,
  bedroomRange: 1,
  limit: 25,
  /** Fewer closed comparables than this and no medians are shown. */
  minimumForMedians: 3,
};
