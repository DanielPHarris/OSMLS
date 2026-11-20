/*
 * The compliance workflow against the test database, by direct call rather
 * than by screen. This is the first proof; the fuller set of viewer, limit,
 * link, and race tests comes with the rest of the work (issue #27).
 */
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../src/db";
import { flag, member, relistingLink, type Member } from "../src/db/schema";
import { closeFlag, flagsOnListing, getRelistingLink, listFlags, raiseFlag, setRelistingLink } from "../src/lib/compliance";
import { createListing } from "../src/lib/listings";
import { createMember, setCapabilities } from "../src/lib/members";

const run = Date.now();
let admin: Member;
let reporter: Member;
let listingAgent: Member;
const smtp = process.env.SMTP_URL;

beforeAll(async () => {
  delete process.env.SMTP_URL;
  const members = await db.select().from(member);
  const byId = (id: string) => members.find((m) => m.MemberMlsId === id)!;
  admin = byId("ST0001");
  reporter = byId("AG1001");
  listingAgent = byId("AG2001");
});
afterAll(async () => {
  process.env.SMTP_URL = smtp;
  await db.update(member).set({ MemberStatus: "Inactive", OsmlsCapabilities: [] }).where(like(member.MemberMlsId, `C${run}-%`));
  await pool.end();
});

describe("staff who do not hold Manage compliance", () => {
  it("are refused the queue, closing a flag, and the relisting link, exactly as if nothing were there", async () => {
    const listing = await createListing(listingAgent, {
      StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
      StreetNumber: "1", StreetName: `Compliance Rd ${run}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98995",
      BedroomsTotal: "3", BathroomsTotalInteger: "2",
    });
    const raised = await raiseFlag(reporter, listing.ListingKey, { category: "Other", description: `Refusal ${run}` });
    const made = (await createMember(admin, { firstName: "No", lastName: "Compliance", email: `c-${run}@osmls.example`, memberId: `C${run}-1`, role: "staff", officeKey: "", phone: "" })).member;
    await setCapabilities(admin, made.MemberKey, ["members", "offices", "settings", "staff"], "everything but compliance");
    const [without] = await db.select().from(member).where(eq(member.MemberKey, made.MemberKey));

    for (const viewer of [without, reporter, listingAgent, null]) {
      expect(await listFlags(viewer)).toBeNull();
      expect(await getRelistingLink(viewer, listing.ListingKey)).toBeNull();
      await expect(closeFlag(viewer, raised.FlagKey, "Resolved", "no")).rejects.toThrow("Not found.");
      await expect(setRelistingLink(viewer, listing.ListingKey, { mode: "none" }, "no")).rejects.toThrow("Not found.");
    }
    // Staff without the capability are not the listing side or the reporter either, so they are shown no flag.
    expect(await flagsOnListing(without, listing.ListingKey)).toEqual([]);
    expect((await db.select().from(flag).where(eq(flag.FlagKey, raised.FlagKey)))[0].State).toBe("Open");
    expect(await db.select().from(relistingLink).where(eq(relistingLink.ListingKey, listing.ListingKey))).toEqual([]);

    // With it, the same calls go through.
    expect((await listFlags(admin, { listing: listing.ListingKey }))!.map((f) => f.raisedBy.memberId)).toEqual(["AG1001"]);
    await setRelistingLink(admin, listing.ListingKey, { mode: "none" }, "proof");
    expect(await getRelistingLink(admin, listing.ListingKey)).toEqual({ mode: "none", listingId: null });
    await closeFlag(admin, raised.FlagKey, "Dismissed", "proof");
    // What the listing side is given has no field that could say who raised it.
    const [theirs] = await flagsOnListing(listingAgent, listing.ListingKey);
    expect(Object.keys(theirs).sort()).toEqual(["category", "closedAt", "closingNote", "description", "flagKey", "mine", "raisedAt", "state"]);
    expect(theirs).toMatchObject({ state: "Dismissed", closingNote: "proof", mine: false });
  });
});
