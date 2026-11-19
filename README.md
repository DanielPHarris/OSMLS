# OSMLS

An open-source MLS platform, created by Daniel P. Harris.

OSMLS is a focused core MLS: the functions people need for everyday work, built as
complete, tested workflows rather than a long list of unfinished features. It is not
an attempt to match the feature set of commercial MLS systems.

## Status

**Version 0.1, in development. Not production-ready.**

- It has not been used by a real MLS and has had no security review.
- It is **not RESO certified** and has not been run through RESO's certification
  tests. Its field names and lookup values follow the RESO Data Dictionary 2.1.
  Data types have not been checked against the Data Dictionary, and there is no
  RESO Web API endpoint yet.
- All people, offices, and listings in the demo are synthetic.

[CHARTER.md](CHARTER.md) records the project's purpose, decisions, scope, and what
remains.

## Screenshots

From the demo, which uses synthetic listings and illustrated placeholder photos.

**An agent searches listings**

![Search form with filters and a results table](docs/screenshots/search.png)

**Map search** (added after 0.1)

![Search page with a map of listing pins, one opened to show its address, price, and status](docs/screenshots/map-search.png)

**A listing, as MLS staff see it**

![Listing page with photos, details, and the listing agent](docs/screenshots/listing.png)

**Its change history, including a staff correction**

![Change history showing who changed each field, old and new values, and a staff correction with its reason](docs/screenshots/history.png)

## Creator and maintainer

OSMLS is created and maintained by [Daniel P. Harris](https://danielpharris.com)
([GitHub](https://github.com/DanielPHarris)). Daniel held senior leadership roles at
Las Vegas REALTORS®, including Chief Technology Officer, Chief Innovation Officer,
and Chief Operating Officer, and served in interim CEO leadership. That experience
in technology and operations leadership shapes OSMLS's priorities: practical agent
workflows, MLS administration, interoperability between vendors, and systems that
keep an accountable record of who changed what.

OSMLS is an independent project. It is not affiliated with or endorsed by Las Vegas
REALTORS® or the Real Estate Standards Organization (RESO).

## What version 0.1 does

One workflow, end to end:

1. **An agent creates a listing.** Required fields and formats are validated. Only
   permitted status changes are allowed. Photos can be uploaded.
2. **Another agent finds it.** Search by listing number, address, city, ZIP code,
   price range, bedrooms, bathrooms, and status, then open the full listing.
3. **MLS staff inspect its history.** Every change records who made it, when, the
   field, and the old and new values. Staff can correct any listing, but must give a
   reason, and the correction is marked as such.

Rules behind it:

- A listing agent can change only their own listings, and not once a listing is
  Closed, Canceled, or Expired. After that, only a staff correction can change it.
- History is written in the same database transaction as the change it describes.
  The database refuses any attempt to edit or delete a history row.
- Photos and listings are visible only to signed-in, active members.

### Added since 0.1: map search

- **Pin a listing.** On the listing form, click the map to place a pin or drag it to
  move it. Latitude and longitude fields show the same position and can be typed
  instead. A location is optional, but it is both coordinates or neither. Changes
  are recorded in the listing's history.
- **See results on a map.** The search page shows a pin for each matching listing
  that has a location. Selecting a pin shows the address, price, and status, with a
  link to the listing. Pins can be reached and opened from the keyboard, and every
  listing on the map is also in the results table.
- **Search this area.** Limits results to the part of the map on screen, together
  with every other filter. The area is kept in the page address, so a search can be
  reloaded or shared with another member.
- **Listings with no location** appear in ordinary searches marked "Location
  unavailable". An area search leaves them out, and says how many, because they
  cannot be placed inside the area.
- **If the map cannot be loaded,** the search form, the results table, and the
  listing form all keep working, and the page says the map is unavailable.

Not included: drawing shapes or radius circles, turning an address into a location
automatically, boundary layers, and map areas that cross the 180th meridian.

#### The map service

The map is drawn with [MapLibre GL JS](https://maplibre.org/). Where the map itself
comes from is one setting, `MAP_STYLE_URL`, which takes any MapLibre-compatible
style URL.

- If it is not set, OSMLS uses [OpenFreeMap](https://openfreemap.org/)'s public
  service, which needs no account or key. **That service comes with no availability
  guarantee and may be discontinued without notice.** It is a default for demos.
  Anyone running OSMLS for real use should choose a map tile service suited to
  their needs, self-hosted or managed, and set `MAP_STYLE_URL` to it.
- The map's credit line comes from the style (for the default: OpenFreeMap,
  OpenMapTiles, and OpenStreetMap) and is always shown in full. Keep it.
- When a member views a map, their browser requests map tiles directly from the
  map service. No listing data is sent to it.
- In the demo data, the towns are invented and pins are arbitrary points. They do
  not mark real properties.

### Added since 0.1: documents and showing instructions

Both carry information that not every member should see, so each has access rules,
enforced on the server in one place ([src/lib/access.ts](src/lib/access.ts)).

**Who is who.** "Listing office" is the one office named on the listing, not the
whole brokerage. "MLS staff" is an active account that holds the staff role. A
suspended (inactive) account can do nothing, whatever its role. Anything the tables
below do not allow is refused.

**Documents.** Each document has one permission. A new document starts at the most
restrictive.

| Permission | Who can view and download |
| --- | --- |
| Listing agent only (the default) | The listing agent and MLS staff |
| Listing office only | The listing agent, agents in the listing office, and MLS staff |
| All MLS members | Any active member |

- The listing agent can add, rename, replace, and delete documents and change their
  permission, until the listing is Closed, Canceled, or Expired. MLS staff can at
  any time, as a correction with a reason.
- PDF, JPEG, and PNG only, identified by the file's content, up to 15 MB each and
  25 per listing. The limits are in
  [src/lib/rules/local.ts](src/lib/rules/local.ts).
- Files are kept in a folder nothing serves directly, under generated names. The
  only way to one is a download route that checks access on every request and
  always sends the file as a download.
- A document someone may not see is left out of what they are sent, and asking for
  it directly gets the same "not found" as a document that does not exist.
- Replacing or deleting a document destroys the old file. History keeps its name,
  type, size, and SHA-256 hash, but not its contents.

**Showing instructions.** Instructions, requirements, a contact, and lockbox type
and location.

| Listing status | Who can view |
| --- | --- |
| Coming Soon, Active, Active Under Contract, Pending, Hold, Withdrawn | Any active member |
| Closed, Canceled, Expired, and any other status | The listing agent, agents in the listing office, and MLS staff |

Showing details never appear in search results.

**Limits you should know about**

- **Files are not scanned for malware.** Checking that a file is a PDF or an image
  says what type it is. It does not show the file is safe to open, PDFs included.
- **Entry codes are a usage restriction, not a guarantee.** OSMLS has no field for
  lockbox combinations or gate codes, and the forms tell agents not to enter them.
  Nothing stops someone typing a code into free text or uploading a file that
  contains one.
- No earlier versions of a replaced document are kept.
- There is no record of who viewed or downloaded a document.
- Files are stored on local disk only.
- Change history, which describes documents by name, is visible to MLS staff only.
- There is no export. Any added later must use the same access rules.

### Added since 0.1: market research

Sold search, days on market, and comparables.

**Days on market are a policy, not a fact.** The RESO Data Dictionary defines both
days on market (DOM) and cumulative days on market (CDOM) only as "defined by the
MLS business rules", so figures from different MLSs are not comparable. OSMLS does
not pick one policy for everyone. It ships defaults, each a named setting in
[src/lib/rules/market-time.ts](src/lib/rules/market-time.ts):

| Setting | What it decides | Default |
| --- | --- | --- |
| Statuses that accumulate days | The one list of statuses in which a listing gains days. In every other status the count is paused. | Active, Active Under Contract |
| Relisting gap | How long a property may be off the market and still have a new listing continue the old count. | 30 days |
| Brokerage change resets the count | Whether a relisting by a different brokerage starts from zero. Brokerages are compared, not offices. | No |
| Address fallback | Whether listings may be matched by address when a parcel match is not possible. | On |
| Gap endpoint | Whether the gap ends when the new listing was entered, or when it first went on the market. | Entered |
| MLS time zone | The time zone whose calendar dates are counted. | Pacific time |

- **These are OSMLS's defaults, not a standard.** An MLS adopting OSMLS should set
  them to match its own rules.
- **Changing a setting takes a developer.** It means editing that file and
  redeploying. There is no screen for it.
- **Changing a setting recalculates the past.** Nothing is stored: the figures are
  worked out from each listing's status history whenever they are shown, so a new
  value changes them for old listings too. A policy cannot be applied from a date.

How the count works with the defaults:

- Days are calendar dates in the MLS time zone. A stretch on the market counts the
  difference between the date it started and the date it ended; time spent Pending,
  on Hold, or Withdrawn in between is not counted.
- CDOM adds the DOM of the earlier listings a listing continues. The most recently
  entered earlier listing of the same property is found first, and only then
  tested: it must have ended Canceled, Expired, or Withdrawn, and the new listing
  must have been entered fewer than 30 days after it ended. If it fails, the chain
  stops there. **A sale always breaks the chain.**
- Two listings are the same property if their parcel number, county, and state all
  match, or, when either lacks a parcel number or county, if their street number,
  street name, city, state, and ZIP code match exactly. Unit numbers must agree
  either way. A parcel number alone never matches, because it is only unique
  within the county that issued it.

**Sold search.** Search by close date and close price, and sort by price, close
date, or days on market. Results show DOM and CDOM.

**Timeline.** Each listing shows members its status and price changes with their
dates. It names no one and says nothing about staff corrections, documents, or
showing instructions; full change history remains for MLS staff.

**Comparables.** From a listing, "Find comparables" lists other listings that are,
by default, closed within 180 days, of the same property type, within 1 mile,
within 20% of its living area, and within 1 bedroom. Each criterion can be changed.
A listing with no map location is compared within its ZIP code instead. The page
shows the median close price, price per square foot, and days on market when there
are at least three sales. **These describe those sales. They are not a valuation,**
and no adjustments are made between properties.

**Limits you should know about**

- Matching by address is fragile: "12 Oak St" and "12 Oak Street" do not match.
- Matching depends on what was typed. A wrong parcel number, county, or unit can
  link unrelated listings or miss a real relisting, and staff can correct that
  only by correcting those fields. There is no tool to link or unlink by hand.
- If a new listing is entered before the earlier one has ended, their days can
  overlap and be counted in both.
- Sorting by days on market works on the listing's own DOM, not CDOM.
- Comparables use distance in a straight line between map pins.

### Not yet built

Sharing with clients or the public, saved searches, alerts, email sharing, reports,
administration screens, compliance flags, imports and exports, a RESO Web API
endpoint, fair-housing checks on remarks, password reset, and production operations
(monitoring, backups, recovery). See the charter for the planned order.

## Try it

You need [Docker](https://docs.docker.com/get-docker/).

```bash
docker compose up --build
```

Open http://localhost:3000. If port 3000 is taken, use another:
`OSMLS_PORT=3300 docker compose up --build`. The database is published on port 5433;
change that with `OSMLS_DB_PORT` (and match it in `.env` if you develop locally).

Sign in with a demo account. The password for all of them is the `DEMO_PASSWORD`
value in [.env.example](.env.example).

| Account | Role |
| --- | --- |
| `alex.rivera@osmls.example` | Agent, Harborview Realty (Demo) |
| `sam.whitfield@osmls.example` | Agent, Summit Line Properties (Demo) |
| `jordan.okafor@osmls.example` | Agent, Harborview Realty (Demo), the same office as Alex |
| `morgan.ellis@osmls.example` | MLS staff |
| `riley.chen@osmls.example` | Suspended agent: can sign in, but is refused everything |

The secrets in `docker-compose.yml` and `.env.example` are for local demos only.

### Walkthrough

1. Sign in as **Alex Rivera**. Choose **New listing**, fill it in, and create it.
   Then choose **Edit listing**, upload a photo, and change the price. Note the
   listing number.
2. Sign out and sign in as **Sam Whitfield**. Search for the listing number and open
   the listing. Sam can read it but cannot edit it or see its history.
3. Sign out and sign in as **Morgan Ellis**. Open the same listing: the change
   history at the bottom shows who entered it, the price change with old and new
   values, and the photo. Choose **Correct listing**, change a field, and try to
   save without a reason.

The search opens showing Active and Coming Soon listings. Clear every status box to
search every status.

To try market research: search for "Comparable Ct" with Closed ticked to see recent
sales, open "1 Comparable Ct" and choose **Find comparables**. Listings on
"Relist Rd" show how the cumulative count carries across a relisting, and when it
does not.

## Develop

You need Node.js 22 or later, [pnpm](https://pnpm.io/), and Docker.

```bash
cp .env.example .env
pnpm install
docker compose up -d db     # PostgreSQL on localhost:5433
pnpm db:migrate
pnpm db:seed
pnpm dev
```

### Tests

```bash
pnpm test                                # rules, validation, and database behaviour
pnpm exec playwright install chromium    # once, to download the test browser
pnpm test:e2e                            # the workflow, map search, access control, and market research in a real browser
pnpm lint && pnpm typecheck
```

Every pull request, and every push to `main`, runs these same commands plus a
production build on GitHub
([.github/workflows/checks.yml](.github/workflows/checks.yml)), in Chromium on
Linux.

Tests use their own database (`TEST_DATABASE_URL`), which is deleted, re-created,
and seeded on the same PostgreSQL server at the start of every run. They never write to the development or
demo database. The browser tests start their own server on port 3210 and use a blank
local map style, so they do not depend on an outside map service. The default map
service was checked by hand in a production build, at desktop and phone widths.

## How it is built

- **TypeScript**, one **Next.js** application, **PostgreSQL**. No hosted services
  are required to run it.
- Schema changes are SQL migrations in [drizzle/](drizzle/), generated from
  [src/db/schema.ts](src/db/schema.ts).
- Listing logic, permissions, and history live in
  [src/lib/listings.ts](src/lib/listings.ts).
- Operating rules an MLS would want to change are kept apart from the rest:
  permitted status changes in [src/lib/rules/status.ts](src/lib/rules/status.ts),
  local formats, limits, and where maps open in
  [src/lib/rules/local.ts](src/lib/rules/local.ts).
- A listing's location is two plain numeric columns, `Latitude` and `Longitude`.
  PostGIS is not used.

### Data model

Tables and columns are named after RESO Data Dictionary 2.1 resources and fields:
`Property`, `Member`, `Office`, `Media`, and `HistoryTransactional`. A document is a `Media` row with
`MediaCategory` "Document", and its permission is the Data Dictionary's
`Media.Permission` (stored as "Agent Only", "Office Only", or "Private"). Lookup values
such as `StandardStatus` use the Data Dictionary's display names.

What has and has not been checked: every field name and lookup value OSMLS uses was
compared with the Data Dictionary 2.1 reference and matches. Data types, and
whether OSMLS would pass RESO's certification tests, have not been checked. OSMLS
offers nine of the ten 2.1 property types; "Commercial Real Estate" is not offered.

Columns that are not in the Data Dictionary start with `Osmls`:

| Column | Purpose |
| --- | --- |
| `Member.OsmlsRole` | `agent` or `staff` |
| `Member.OsmlsUserId` | Links a member to their sign-in account |
| `Property.OsmlsLocalFields` | Reserved for an MLS's own fields; not used yet |
| `Media.OsmlsStoragePath` | Generated file name of the stored photo or document |
| `Media.OsmlsFileSize`, `Media.OsmlsFileHash` | Size and SHA-256 hash of a stored document |
| `HistoryTransactional.OsmlsStaffCorrection` | Whether MLS staff made the change |
| `HistoryTransactional.OsmlsCorrectionReason` | The reason staff gave |

"Listing agent" is not a separate role. It is the agent named in `ListAgentKey` on a
given listing.

OSMLS is an independent project. It is not affiliated with or endorsed by the Real
Estate Standards Organization, and contains none of RESO's code or files.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Daniel P. Harris.
