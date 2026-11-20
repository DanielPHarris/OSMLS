/*
 * A client link asked for by a member who is suspended while the request is
 * waiting (issue #29). The mail server is stood in for, so the test can say
 * for certain that nothing was sent.
 */
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "../src/db";
import { member, share, type Member } from "../src/db/schema";
import { createListing } from "../src/lib/listings";
import type { Mail } from "../src/lib/mail";
import { createMember } from "../src/lib/members";
import { createShare } from "../src/lib/shares";
import { overlapping } from "./overlap";

const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/lib/mail", async (original) => ({
  ...(await original<typeof import("../src/lib/mail")>()),
  mailEnabled: () => true,
  sendMail: async (mail: Mail) => void sent.push(mail),
}));

const run = Date.now();
let admin: Member;
let office: string;
let serial = 0;

beforeAll(async () => {
  const members = await db.select().from(member);
  admin = members.find((m) => m.MemberMlsId === "ST0001")!;
  office = members.find((m) => m.MemberMlsId === "AG1001")!.OfficeKey!;
});
afterAll(async () => {
  await db.update(member).set({ MemberStatus: "Inactive" }).where(like(member.MemberMlsId, `SS${run}-%`));
  await pool.end();
});

async function agentWithListing() {
  const n = ++serial;
  const agent = (
    await createMember(admin, { firstName: "Sharing", lastName: `Agent${n}`, email: `sharing-${run}-${n}@osmls.example`, memberId: `SS${run}-${n}`, role: "agent", officeKey: office, phone: "" })
  ).member;
  const listing = await createListing(agent, {
    StandardStatus: "Active", PropertyType: "Residential", ListPrice: "500000", ListingContractDate: "2026-01-01",
    StreetNumber: String(n), StreetName: `Suspension Rd ${run}`, City: "Testville", StateOrProvince: "WA", PostalCode: "98994",
    BedroomsTotal: "3", BathroomsTotalInteger: "2",
  });
  return { agent, listing };
}
const rowOf = (m: Member) => `select 1 from "Member" where "MemberKey" = '${m.MemberKey}' for update`;
const suspend = (m: Member) => `update "Member" set "MemberStatus" = 'Inactive' where "MemberKey" = '${m.MemberKey}'`;
const links = (m: Member) => db.select().from(share).where(eq(share.MemberKey, m.MemberKey));

describe("a link asked for by a member suspended while the request was waiting", () => {
  it("is not made and not emailed", async () => {
    const { agent, listing } = await agentWithListing();
    const to = `client-${run}@clients.example`;
    sent.length = 0;
    // The suspension holds the member's row, as the real one does; the request carries what the session saw before it.
    const result = await overlapping(rowOf(agent), suspend(agent), () => createShare(agent, { listing: listing.ListingKey }, { email: to }));
    expect(agent.MemberStatus).toBe("Active");
    expect(result).toMatchObject({ status: "rejected", reason: { message: "Listing not found." } });
    expect(await links(agent)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("is not made when no address was given either", async () => {
    const { agent, listing } = await agentWithListing();
    const result = await overlapping(rowOf(agent), suspend(agent), () => createShare(agent, { listing: listing.ListingKey }, {}));
    expect(result).toMatchObject({ status: "rejected", reason: { message: "Listing not found." } });
    expect(await links(agent)).toEqual([]);
  });

  it("is made and emailed as before for a member who is still active", async () => {
    const { agent, listing } = await agentWithListing();
    const to = `client-active-${run}@clients.example`;
    sent.length = 0;
    const made = await createShare(agent, { listing: listing.ListingKey }, { email: to });
    expect(made.emailedTo).toBe(to);
    expect(await links(agent)).toHaveLength(1);
    expect((sent as Mail[]).map((m) => m.to)).toEqual([to]);
  });
});
