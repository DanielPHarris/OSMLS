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

describe("upgrading an installation that already has staff", () => {
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

  it("then gives Manage compliance to whoever holds Manage staff, and to no one else", async () => {
    // Before this upgrade, one staff account was narrowed and another had given up managing staff.
    await scratch.query(`update "Member" set "OsmlsCapabilities" = '{members}' where "MemberMlsId" = 'S2'`);
    await scratch.query(`update "Member" set "OsmlsCapabilities" = '{members,offices,settings}' where "MemberMlsId" = 'S4'`);

    await apply("0012_compliance_flags.sql");
    // Applying the capability step twice gives it once.
    const again = readFileSync(join("drizzle", "0012_compliance_flags.sql"), "utf8").split("--> statement-breakpoint").pop()!;
    await scratch.query(again);

    const { rows } = await scratch.query(`select "MemberMlsId" as id, "OsmlsCapabilities" as held from "Member" order by "MemberMlsId"`);
    expect(rows).toEqual([
      { id: "A1", held: [] },
      { id: "A2", held: [] },
      { id: "S1", held: ["members", "offices", "settings", "staff", "compliance"] },
      { id: "S2", held: ["members"] },
      { id: "S3", held: ["members", "offices", "settings", "staff", "compliance"] },
      { id: "S4", held: ["members", "offices", "settings"] },
    ]);
    const { rows: tables } = await scratch.query(`select count(*)::int as n from "OsmlsFlag"`);
    expect(tables[0].n).toBe(0);
  });

  it("then gives Manage data access to whoever holds Manage staff, and to no one else", async () => {
    await apply("0013_data_exchange.sql");
    const again = readFileSync(join("drizzle", "0013_data_exchange.sql"), "utf8").split("--> statement-breakpoint").pop()!;
    await scratch.query(again);
    const { rows } = await scratch.query(`select "MemberMlsId" as id, "OsmlsCapabilities" as held from "Member" order by "MemberMlsId"`);
    expect(rows).toEqual([
      { id: "A1", held: [] },
      { id: "A2", held: [] },
      { id: "S1", held: ["members", "offices", "settings", "staff", "compliance", "data"] },
      { id: "S2", held: ["members"] },
      { id: "S3", held: ["members", "offices", "settings", "staff", "compliance", "data"] },
      { id: "S4", held: ["members", "offices", "settings"] },
    ]);
    const { rows: consumers } = await scratch.query(`select count(*)::int as n from "OsmlsDataConsumer"`);
    expect(consumers[0].n).toBe(0);
  });

  it("then puts every existing data consumer on the full feed, which is what it already read", async () => {
    // Before feeds existed: two consumers, one of them revoked, and a request one of them made.
    const { rows: [staff] } = await scratch.query(`select "MemberKey" from "Member" where "MemberMlsId" = 'S1'`);
    const { rows: made } = await scratch.query(
      `insert into "OsmlsDataConsumer" ("ConsumerName", "OsmlsTokenHash", "CreatedByMemberKey", "RevokedTimestamp", "RevokedByMemberKey")
       values ('Existing', 'hash-one', $1, null, null), ('Existing, revoked', 'hash-two', $1, now(), $1) returning "ConsumerKey"`,
      [staff.MemberKey],
    );
    await scratch.query(`insert into "OsmlsDataRequest" ("ConsumerKey", "ResourceName", "Query", "Status", "RecordCount") values ($1, 'Property', '', 200, 5)`, [made[0].ConsumerKey]);

    await apply("0014_feeds_and_export.sql");

    const { rows: after } = await scratch.query(`select "ConsumerName" as name, "Feed" as feed, "OsmlsTokenHash" as hash from "OsmlsDataConsumer" order by 1`);
    expect(after).toEqual([
      { name: "Existing", feed: "full", hash: "hash-one" },
      { name: "Existing, revoked", feed: "full", hash: "hash-two" },
    ]);
    expect((await scratch.query(`select "Feed" as feed, "RecordCount" as n from "OsmlsDataRequest"`)).rows).toEqual([{ feed: "full", n: 5 }]);
    // Only the two feeds can be stored.
    await expect(scratch.query(`update "OsmlsDataConsumer" set "Feed" = 'everything'`)).rejects.toThrow(/OsmlsDataConsumer_Feed_valid/);
    expect((await scratch.query(`select count(*)::int as n from "OsmlsExport"`)).rows[0].n).toBe(0);
  });

  it("then gives Import listings to whoever holds Manage staff, and to no one else", async () => {
    await apply("0015_listing_imports.sql");
    const again = readFileSync(join("drizzle", "0015_listing_imports.sql"), "utf8").split("--> statement-breakpoint").pop()!;
    await scratch.query(again);
    const { rows } = await scratch.query(`select "MemberMlsId" as id, "OsmlsCapabilities" as held from "Member" order by "MemberMlsId"`);
    expect(rows).toEqual([
      { id: "A1", held: [] },
      { id: "A2", held: [] },
      { id: "S1", held: ["members", "offices", "settings", "staff", "compliance", "data", "imports"] },
      { id: "S2", held: ["members"] },
      { id: "S3", held: ["members", "offices", "settings", "staff", "compliance", "data", "imports"] },
      { id: "S4", held: ["members", "offices", "settings"] },
    ]);
    expect((await scratch.query(`select count(*)::int as n from "OsmlsImport"`)).rows[0].n).toBe(0);
  });
});
