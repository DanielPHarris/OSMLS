/*
 * Upgrading an installation that already has staff. A scratch database is
 * brought to the state before staff capabilities existed, given members, and
 * then upgraded with the real migration file.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NAME = "osmls_upgrade_test";
const UPGRADE = "0011_staff_capabilities_and_settings.sql";
const url = (database: string) => {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${database}`;
  return u.toString();
};
let admin: Client;
let scratch: Client;

const apply = async (file: string) => {
  for (const statement of readFileSync(join("drizzle", file), "utf8").split("--> statement-breakpoint")) await scratch.query(statement);
};

beforeAll(async () => {
  admin = new Client({ connectionString: url("postgres") });
  await admin.connect();
  await admin.query(`drop database if exists ${NAME} with (force)`);
  await admin.query(`create database ${NAME}`);
  scratch = new Client({ connectionString: url(NAME) });
  await scratch.connect();
  const before = readdirSync("drizzle").filter((f) => f.endsWith(".sql") && f < UPGRADE).sort();
  expect(before).toHaveLength(11);
  for (const file of before) await apply(file);
});
afterAll(async () => {
  await scratch.end();
  await admin.query(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

describe("upgrading to staff capabilities and stored settings", () => {
  it("gives every existing staff account all four capabilities, agents none, and stores the starting settings", async () => {
    const people: [id: string, role: string, status: string][] = [
      ["S1", "staff", "Active"],
      ["S2", "staff", "Active"],
      ["S3", "staff", "Inactive"],
      ["A1", "agent", "Active"],
      ["A2", "agent", "Inactive"],
    ];
    const { rows: [office] } = await scratch.query(`insert into "Office" ("OfficeMlsId", "OfficeName") values ('O1', 'Upgrade Office') returning "OfficeKey"`);
    for (const [id, role, status] of people) {
      await scratch.query(`insert into "user" ("id", "name", "email") values ($1, $1, $1 || '@osmls.example')`, [id]);
      await scratch.query(
        `insert into "Member" ("MemberMlsId", "MemberFirstName", "MemberLastName", "MemberFullName", "MemberEmail", "MemberStatus", "OfficeKey", "OsmlsRole", "OsmlsUserId")
         values ($1, $1, $1, $1, $1 || '@osmls.example', $2, $3, $4, $1)`,
        [id, status, role === "agent" ? office.OfficeKey : null, role],
      );
    }

    await apply(UPGRADE);

    const { rows: members } = await scratch.query(`select "MemberMlsId" as id, "OsmlsCapabilities" as held from "Member" order by "MemberMlsId"`);
    const all = ["members", "offices", "settings", "staff"];
    expect(members).toEqual([
      { id: "A1", held: [] },
      { id: "A2", held: [] },
      { id: "S1", held: all },
      { id: "S2", held: all },
      // Suspended staff keep theirs too: they allow nothing until the account is reinstated.
      { id: "S3", held: all },
    ]);
    const { rows: settings } = await scratch.query(`select * from "OsmlsMarketTimeSettings"`);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      Version: 1,
      AccumulatingStatuses: ["Active", "Active Under Contract"],
      RelistingGapDays: 30,
      BrokerageChangeResets: false,
      AddressFallback: true,
      GapEndpoint: "entered",
      TimeZone: "America/Los_Angeles",
      ChangedByMemberKey: null,
    });
    // A member added after the upgrade starts with none.
    await scratch.query(`insert into "user" ("id", "name", "email") values ('S4', 'S4', 'S4@osmls.example')`);
    const { rows: [added] } = await scratch.query(
      `insert into "Member" ("MemberMlsId", "MemberFirstName", "MemberLastName", "MemberFullName", "MemberEmail", "OsmlsRole", "OsmlsUserId")
       values ('S4', 'S4', 'S4', 'S4', 'S4@osmls.example', 'staff', 'S4') returning "OsmlsCapabilities" as held`,
    );
    expect(added.held).toEqual([]);
  });
});
