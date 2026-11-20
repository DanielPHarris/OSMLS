/*
 * One version of the market-time settings for the whole of a server action.
 *
 * Sharing a listing by email reads the MLS time zone twice: once for the date
 * in the email, and once for the date in the message shown afterwards. The
 * settings are changed between the two, as another staff member's save could,
 * and the two dates must still agree.
 *
 * The action is called directly. What only a web request can supply is stood
 * in for: who is signed in, the mail server, and page revalidation.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "../src/db";
import { member, share, type Member } from "../src/db/schema";
import { createListing } from "../src/lib/listings";
import type { Mail } from "../src/lib/mail";
import { latestSettings } from "../src/lib/market-time";
import { STARTING_MARKET_TIME_SETTINGS, type MarketTimeSettings } from "../src/lib/rules/market-time";
import { saveMarketTimeSettings } from "../src/lib/settings";

const stand = vi.hoisted(() => ({ signedIn: null as unknown, send: (async () => {}) as (mail: unknown) => Promise<void> }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("../src/lib/session", () => ({ getCurrentMember: async () => stand.signedIn }));
vi.mock("../src/lib/mail", async (original) => ({
  ...(await original<typeof import("../src/lib/mail")>()),
  mailEnabled: () => true,
  sendMail: (mail: Mail) => stand.send(mail),
}));

const { shareAction } = await import("../src/app/share-actions");

const run = Date.now();
let staff: Member;
let agent: Member;
async function change(changes: Partial<MarketTimeSettings>) {
  const { version, ...now } = await latestSettings();
  return saveMarketTimeSettings(staff, { ...now, ...changes }, version, "test");
}

beforeAll(async () => {
  const members = await db.select().from(member);
  staff = members.find((m) => m.MemberMlsId === "ST0001")!;
  agent = members.find((m) => m.MemberMlsId === "AG1001")!;
});
afterAll(async () => {
  await change(STARTING_MARKET_TIME_SETTINGS);
  await db.delete(share).where(eq(share.OsmlsRecipientEmail, `client-${run}@osmls.example`));
  await pool.end();
});

describe("sharing a listing by email while the settings change", () => {
  it("gives the same expiry date in the email and in the message shown afterwards", async () => {
    const listing = await createListing(agent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: "1", StreetName: `Action Rd ${run}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98996",
      BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    // These two zones are 25 hours apart, so at every moment they are on different calendar dates.
    await change({ timeZone: "Pacific/Pago_Pago" });
    const sent: Mail[] = [];
    stand.signedIn = agent;
    stand.send = async (mail) => {
      sent.push(mail as Mail);
      await change({ timeZone: "Pacific/Kiritimati" });
    };
    const form = new FormData();
    form.set("email", `client-${run}@osmls.example`);

    const state = await shareAction({ listing: listing.ListingKey }, {}, form);

    expect(state.ok).toBe(true);
    expect(sent).toHaveLength(1);
    // The change was saved while the action was running.
    expect((await latestSettings()).timeZone).toBe("Pacific/Kiritimati");
    const until = (text: string) => text.match(/works until ([^.]+)\./)?.[1];
    expect(until(sent[0].text)).toBeTruthy();
    expect(until(state.message!)).toBe(until(sent[0].text));
  });
});
