import { describe, expect, it } from "vitest";
import { canViewDocument, canViewShowing, type ListingSide, type Viewer } from "../src/lib/access";
import { DOCUMENT_PERMISSIONS, STANDARD_STATUSES } from "../src/lib/lookups";

const listing = (status = "Active"): ListingSide => ({
  ListAgentKey: "agent-1",
  ListOfficeKey: "office-1",
  StandardStatus: status,
});

const member = (changes: Partial<NonNullable<Viewer>>): NonNullable<Viewer> => ({
  MemberKey: "someone",
  OfficeKey: "office-9",
  OsmlsRole: "agent",
  MemberStatus: "Active",
  ...changes,
});

const viewers: Record<string, Viewer> = {
  "the listing agent": member({ MemberKey: "agent-1", OfficeKey: "office-1" }),
  "an agent in the listing office": member({ MemberKey: "agent-2", OfficeKey: "office-1" }),
  "an agent in another office": member({ MemberKey: "agent-3", OfficeKey: "office-2" }),
  "MLS staff": member({ MemberKey: "staff-1", OfficeKey: null, OsmlsRole: "staff" }),
  "a suspended listing agent": member({ MemberKey: "agent-1", OfficeKey: "office-1", MemberStatus: "Inactive" }),
  "a suspended agent in the listing office": member({ MemberKey: "agent-2", OfficeKey: "office-1", MemberStatus: "Inactive" }),
  "suspended MLS staff": member({ MemberKey: "staff-2", OfficeKey: null, OsmlsRole: "staff", MemberStatus: "Inactive" }),
  "an account with an unknown role": member({ MemberKey: "agent-1", OfficeKey: "office-1", OsmlsRole: "auditor" }),
  "a signed-out visitor": null,
};

describe("who may view a document", () => {
  // Every viewer against every permission. Anyone not named is refused.
  const allowed: Record<string, string[]> = {
    Private: ["the listing agent", "an agent in the listing office", "an agent in another office", "MLS staff"],
    "Office Only": ["the listing agent", "an agent in the listing office", "MLS staff"],
    "Agent Only": ["the listing agent", "MLS staff"],
  };

  for (const permission of DOCUMENT_PERMISSIONS)
    for (const [who, viewer] of Object.entries(viewers)) {
      const expected = allowed[permission].includes(who);
      it(`${permission}: ${who} ${expected ? "may" : "may not"}`, () => {
        expect(canViewDocument(viewer, listing(), permission)).toBe(expected);
      });
    }

  it("covers every permission the application offers", () => {
    expect(Object.keys(allowed).sort()).toEqual([...DOCUMENT_PERMISSIONS].sort());
  });

  it("admits only staff when the permission is missing or unrecognised", () => {
    for (const permission of [null, "", "Public", "IDX", "Firm Only", "private"])
      for (const [who, viewer] of Object.entries(viewers))
        expect(canViewDocument(viewer, listing(), permission), `${permission} / ${who}`).toBe(who === "MLS staff");
  });

  it("does not treat an agent with no office as being in a listing office", () => {
    const noOffice = member({ MemberKey: "agent-4", OfficeKey: null });
    expect(canViewDocument(noOffice, { ...listing(), ListOfficeKey: null as unknown as string }, "Office Only")).toBe(false);
  });

  it("does not depend on the listing's status", () => {
    for (const status of STANDARD_STATUSES)
      expect(canViewDocument(viewers["an agent in another office"], listing(status), "Agent Only")).toBe(false);
  });
});

describe("who may view showing instructions", () => {
  const listingSide = ["the listing agent", "an agent in the listing office", "MLS staff"];
  const open = ["Coming Soon", "Active", "Active Under Contract", "Pending", "Hold", "Withdrawn"];
  const restricted = ["Closed", "Canceled", "Expired"];

  it("splits every status the application knows into open or restricted", () => {
    expect([...open, ...restricted].sort()).toEqual([...STANDARD_STATUSES].sort());
  });

  for (const status of open)
    for (const [who, viewer] of Object.entries(viewers)) {
      const expected = [...listingSide, "an agent in another office"].includes(who);
      it(`${status}: ${who} ${expected ? "may" : "may not"}`, () => {
        expect(canViewShowing(viewer, listing(status))).toBe(expected);
      });
    }

  for (const status of restricted)
    for (const [who, viewer] of Object.entries(viewers)) {
      const expected = listingSide.includes(who);
      it(`${status}: ${who} ${expected ? "may" : "may not"}`, () => {
        expect(canViewShowing(viewer, listing(status))).toBe(expected);
      });
    }

  it("restricts a status it has never heard of to the listing side", () => {
    for (const [who, viewer] of Object.entries(viewers))
      expect(canViewShowing(viewer, listing("Some Future Status")), who).toBe(listingSide.includes(who));
  });
});
