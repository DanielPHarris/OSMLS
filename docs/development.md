# Development

How OSMLS is built, how to run it for development, how it is tested, and its data model.

[Back to the README](../README.md)

## Run it for development

You need Node.js 22 or later, [pnpm](https://pnpm.io/), and Docker.

```bash
cp .env.example .env
pnpm install
docker compose up -d db mail   # PostgreSQL on localhost:5433, mail catcher on 1025 (read it at :8025)
pnpm db:migrate
pnpm db:seed
pnpm dev
```

### Tests

```bash
pnpm test                                # rules, validation, and database behaviour
pnpm exec playwright install chromium    # once, to download the test browser
pnpm test:e2e                            # the workflow, map search, access control, market research, saved work, sharing, administration, staff permissions, compliance flags, the data exchange feeds, file export, and imports in a real browser
pnpm lint && pnpm typecheck
```

Every pull request, and every push to `main`, runs these same commands plus a
production build on GitHub
([.github/workflows/checks.yml](../.github/workflows/checks.yml)), in Chromium on
Linux.

Tests use their own database (`TEST_DATABASE_URL`), which is deleted, re-created,
and seeded on the same PostgreSQL server at the start of every run. They never write to the development or
demo database. The browser tests build the application and start their own
production server on port 3210, and use a blank local map style, so they do not
depend on an outside map service. They run against the production build because
the development server closes idle connections after five seconds and cannot be
told otherwise, which is the likely cause of requests that failed at random. The sharing tests
send real email to the mail catcher (`docker compose up -d mail`) and read it back. The default map
service was checked by hand in a production build, at desktop and phone widths.
The staff permissions test changes the market-time settings that other tests'
figures depend on, so it runs after the rest and puts them back. The compliance
test changes one of those figures, so it runs last and does the same.

## How it is built

- **TypeScript**, one **Next.js** application, **PostgreSQL**. No hosted services
  are required to run it.
- Schema changes are SQL migrations in [drizzle/](../drizzle/), generated from
  [src/db/schema.ts](../src/db/schema.ts).
- Listing logic, permissions, and history live in
  [src/lib/listings.ts](../src/lib/listings.ts).
- Operating rules an MLS would want to change are kept apart from the rest:
  permitted status changes in [src/lib/rules/status.ts](../src/lib/rules/status.ts),
  local formats, limits, and where maps open in
  [src/lib/rules/local.ts](../src/lib/rules/local.ts).
- A listing's location is two plain numeric columns, `Latitude` and `Longitude`.
  PostGIS is not used.

### Data model

Tables and columns are named after RESO Data Dictionary 2.1 resources and fields:
`Property`, `Member`, `Office`, `Media`, and `HistoryTransactional`. A document is a `Media` row with
`MediaCategory` "Document", and its permission is the Data Dictionary's
`Media.Permission` (stored as "Agent Only", "Office Only", or "Private"). Lookup values
such as `StandardStatus` use the Data Dictionary's display names.

What has and has not been checked: every field name and lookup value OSMLS uses was
compared with the Data Dictionary 2.1 reference and matches. The data types of the
fields the data exchange feed serves were checked by RESO's tool against a local
instance, within the limits described in the [data exchange guide](data-exchange.md); fields outside the feed
have not been checked, and OSMLS has not been through certification. OSMLS
offers nine of the ten 2.1 property types; "Commercial Real Estate" is not offered.

Columns that are not in the Data Dictionary start with `Osmls`:

| Column | Purpose |
| --- | --- |
| `Member.OsmlsRole` | `agent` or `staff` |
| `Member.OsmlsCapabilities` | What a staff account may administer |
| `OsmlsMarketTimeSettings` (table) | The market-time settings, one row per saved version |
| `OsmlsFlag` (table) | Flags raised on listings, and how each was closed |
| `OsmlsRelistingLink` (table) | The earlier listing compliance staff said a listing continues, or none |
| `OsmlsDataConsumer` (table) | Outside systems that may read a data exchange feed, each with its feed and the hash of its bearer token |
| `OsmlsDataRequest` (table) | Each request a data consumer made, the feed that answered, and how many records it was given |
| `OsmlsExport` (table) | Each file a member exported from a search: who, which kind, the search, and how many listings |
| `OsmlsImport`, `OsmlsImportRow` (tables) | Each file of new listings staff uploaded, each row's outcome, and the listing it created |
| `Member.OsmlsUserId` | Links a member to their sign-in account |
| `Property.OsmlsLocalFields` | Reserved for an MLS's own fields; not used yet |
| `Media.OsmlsStoragePath` | Generated file name of the stored photo or document |
| `Media.OsmlsFileSize`, `Media.OsmlsFileHash` | Size and SHA-256 hash of a stored document |
| `HistoryTransactional.OsmlsSequence` | The order history rows were committed in |
| `SavedSearch.OsmlsCriteria` | A saved search's criteria, in OSMLS's own form |
| `SavedSearch.OsmlsActivitySeenThrough` | The history sequence number a saved search's activity has been seen up to |
| `SavedSearch.OsmlsActivitySeenAt` | When that was last set |
| `SavedSearch.OsmlsAlertFrequency` | Email alerts: daily, weekly, or empty for off |
| `SavedSearch.OsmlsAlertSentThrough`, `OsmlsAlertLastSentAt` | The email checkpoint, and when the schedule last started |
| `SavedSearch.OsmlsAlertAttempts`, `OsmlsAlertFailures`, `OsmlsAlertPaused` | Sends with an unknown outcome, refusals in a row, and why sending is paused |
| `SavedSearch.OsmlsAlertGeneration` | Raised by each change the member makes, so a late send cannot undo it |
| `OsmlsShare` | A link given to a client: who made it, a hash of the link, what it shows, when it expires or was revoked, and the recipient's address while kept |
| `OsmlsMailBlock` | Keyed hashes of addresses that asked for no more email |
| `HistoryTransactional.ResourceName` | `Property` for a listing's history; `Member` or `Office` for an administrative change to one |
| `HistoryTransactional.OsmlsStaffCorrection` | Whether MLS staff made the change |
| `HistoryTransactional.OsmlsCorrectionReason` | The reason staff gave |

"Listing agent" is not a separate role. It is the agent named in `ListAgentKey` on a
given listing.

Saved searches use the Data Dictionary's `SavedSearch` resource and its field
names. Its `SearchQuery` field is defined for `$filter` and DMQL2 queries, which
OSMLS does not produce, so the criteria are kept in `OsmlsCriteria` instead.
Collections have no Data Dictionary resource; their tables are `OsmlsCollection` and
`OsmlsCollectionListing`.

OSMLS is an independent project. It is not affiliated with or endorsed by the Real
Estate Standards Organization, and contains none of RESO's code or files.
