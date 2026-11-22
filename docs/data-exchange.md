# Data exchange

How listings leave and enter OSMLS: a read-only RESO Web API feed for outside systems, file export for members, and importing new listings from a file.

[Back to the README](../README.md)

## Data exchange, a read-only RESO Web API feed

An outside system holding a bearer
token reads listings, agents, offices and photo records in the RESO Web API's
OData form, at `/api/reso`. A second, narrower feed, file export, and importing new listings are described after this.

**A distribution policy.** The feed is a new way for listing data to leave OSMLS.
It is wider than a client copy: it carries listings in every status, parcel and
coordinates, and agent and office records. It is narrower than what a member
sees: it never carries documents, showing instructions, or lock box details.
What it carries is for the MLS to decide; these are OSMLS's starting choices.

**The allowlist.** [src/lib/rules/data-exchange.ts](../src/lib/rules/data-exchange.ts)
lists every resource and field the feed may carry, by hand. It is the only source
for the feed's metadata, its Field and Lookup resources, its responses, and what
a query may name. A column added to the database is not served until it is added
there. **Data access** in the page header shows the list to staff.

| Resource | Carries |
| --- | --- |
| Property | Every listing: identifiers, status, type, prices, dates, address, county, parcel, coordinates, rooms and size, public remarks, listing agent and office keys, timestamps, days on market and cumulative days on market |
| Member | Agents only: keys, member ID, name, status, office. No email or phone, and no MLS staff accounts |
| Office | Keys, office ID, name, main office, status, phone, city, state |
| Media | Photos of listings only: keys, order, description, type, and an address to fetch the photo from |
| Field, Lookup | The served fields, and the values of the fields that hold one of a list |

Never in the feed: showing instructions and contacts, lock box fields, documents
and their records, change history, flags, relisting links, saved work, shares,
members' email and phone, roles and capabilities, sign-in identities, and file
storage details. Naming something that is not served, in any query option or in
the address, is an error, never a silent omission.

**Reading it.**

- `$select`, `$filter` (comparisons joined by `and`, `or`, `not`), `$orderby`,
  `$top`, `$skip`, `$count`, one record by key, and `$expand=Media` on Property.
- `$top` is the most records wanted. A page holds at most 200; only a page the
  server cut short carries `@odata.nextLink`. `Prefer: odata.maxpagesize` asks
  for smaller pages.
- A page link carries the place of the last record read, not a count to skip, so
  records added or changed while a consumer is reading do not make it repeat or
  miss one.
- Times are served to the millisecond, and compared, sorted and paged at the
  millisecond, so a filter on a served time finds its record. Stored times keep
  their full precision.
- `contains`, `startswith` and `endswith` are not supported. RESO's tool treats
  them as optional.

**Lookups.** StandardStatus, PropertyType, MemberStatus, OfficeStatus, and the
feed's one media category and resource name are fixed lists and are given as the
standard values they are. City, county, state and media type are whatever served
records hold: the Lookup resource lists the values found in served records only.
A found state is called a standard value only if it is a real postal
abbreviation; cities, counties and media types are given as local values, with no
claim that they are standard.

**Who may read.**

- Staff who hold "Manage data access" add a named data consumer and are shown its
  bearer token once. Only a hash is stored. A token can carry an expiry and can be
  revoked, and is then refused from the next request.
- A member's sign-in opens nothing in the feed, and a token opens nothing else.
- Photos are fetched from the address in `MediaURL` with the same token. That
  route serves photos only.
- Every request is logged with the consumer, what was asked, and how many records
  were returned. A consumer is limited to 1,200 requests a minute.

**What polling does and does not keep current.** Complete synchronization is not
promised.

- A consumer that polls on `ModificationTimestamp` receives every record whose own
  stored fields changed. Listings and offices are never deleted.
- **Days on market** and cumulative days on market are worked out when a response
  is made. They change with time, with a market-time settings change, and with a
  relisting-link correction, none of which moves a listing's timestamp. A consumer
  that keeps them reads its listings again to refresh them.
- Filtering or sorting on those two figures works them out for every listing in
  the feed first. That is correct and it is not cheap; on a large MLS it would
  need its own design.
- **Photos.** Adding or removing a photo moves its listing's timestamp, so a poll
  reports the listing, and reading it with `$expand=Media` gives its photos as
  they now are. A removed photo's own record is simply gone.
- **Members.** The feed carries agents only. An agent made MLS staff stays in the
  database and leaves the feed, and nothing reports that. A consumer reconciles by
  reading the current member keys and treating those it no longer finds as gone.
- RESO's EntityEvent change feed is not built.

**RESO's certification tool.** RESO publishes the tool it certifies with
(`@reso-standards/reso-certification`). It was run from outside this repository
against a local instance on 2026-11-20, version 0.13.1. None of RESO's files are
in this repository.

| Run | Web API Core 2.1.0 | Data Dictionary 2.1 |
| --- | --- | --- |
| First, on the first working feed | 67 passed, 11 failed, 87 skipped | Metadata validation failed with 12 issues; records not reached |
| Final, on commit `6b92774` | 153 passed, 0 failed, 173 skipped; 18 optional scenarios not supported | 6 steps passed, 1 skipped; 756 records replicated and validated in strict mode; 49 warnings |

The final run tested the feed's code as it stood at commit `6b92774`. The only
change after it in the pull request that added the feed is this paragraph and the
table row above.

What the first run found, and what was done:

- A next-page link was returned when the records asked for had all been given (3
  failures). Fixed.
- A filter on a served time did not find its own record, because of the
  millisecond difference above (6 failures). Fixed.
- Days on market could not be filtered on (2 failures). They now can.
- `LivingArea` was declared as a whole number and is a decimal in the Data
  Dictionary. Fixed.
- Eleven fields that hold one of a list of values did not say so, and there was no
  Lookup resource. Built.

What the final run does **not** show:

- **It is not a certification**, and its report says it is not eligible for one.
- **Variations were not checked.** That step sends the feed's field and value names
  to RESO's service and needs RESO credentials. It was skipped, so whether any
  local name is too close to a standard one is unknown. A run that skips it cannot
  be certified.
- **HTTPS was not tested.** The specification requires HTTPS with TLS 1.2 or later.
  OSMLS serves plain HTTP and expects a deployment to put TLS in front of it; there
  is no hosted instance.
- **The data was synthetic and small**: the seeded demo listings, with placeholder
  photos added by `pnpm feed:fixtures`. Certification samples up to 100,000 records
  per resource.
- **Skipped scenarios are not passes.** The tool records no reason for a skip. By
  their names, the 173 are scenarios for a data type or expansion a resource does
  not have (a decimal filter on Member, for example), and for forms the feed does
  not use: OData enumeration types and multi-valued lookups. The feed has no
  multi-valued lookup at all, so those are untested, not passed.
- **The 49 warnings** are suggested maximum lengths and precisions that the
  metadata does not declare.
- The first run's Data Dictionary step was made with a 1,000-record limit and
  without strict mode, to survey everything at once; the final run used neither.

Not included: writing through the API, EntityEvent, feeds with differing field
sets, file export, imports, webhooks, and a hosted instance.

## Feeds and file export

A second feed, one feed for each data consumer, and exporting search results to
a file.

**Feeds.** A feed is what one kind of data consumer may read. Each is written out
by hand in [src/lib/rules/data-exchange.ts](../src/lib/rules/data-exchange.ts), beside
the allowlist, and can only narrow it: it names fields that are on the allowlist,
may add a condition on which records it carries, and may give less than a stored
value. A test fails if a feed names anything that is not on the allowlist.

| | Full | Public display |
| --- | --- | --- |
| Listings | Every status | Active, Active Under Contract, Pending, Closed |
| Property | Everything on the allowlist | Keys, listing number, status, type, list price, sale price and date, address, city, state, ZIP code, bedrooms, bathrooms, living area, lot size, year built, public remarks, last change |
| Left off Property | Nothing | Parcel, county, coordinates, original list price, days on market, street parts, contract and on-market dates, other timestamps |
| Member | Agents, with member ID and status | Agents who have a listing in this feed: key, name, office |
| Office | With office ID, status, phone, city, state | Offices that have a listing in this feed: key and name |
| Media | Photos of any listing | Photos of listings in this feed |

- **"Public display" is what the narrower feed is meant for.** It is still read only
  with a token, and being in it does not by itself mean a consumer may publish a
  listing: that is between the MLS and the consumer.
- **Everything follows the feed.** A consumer's metadata, Field and Lookup
  resources, responses, query options, expansions, reads by key, and photos all
  answer for its own feed. A field or record outside it does not exist for that
  consumer. Lookup values found in data come only from records in that feed.
- **Sale details only for sales.** In the public display feed, a sale price and date
  are given only for a Closed listing, as on a client copy. A filter or a sort sees
  what a response would give, so a figure that is not served cannot be found by
  asking about it.
- **Leaving a feed.** A listing that moves to a status its feed does not carry stays
  in the database and leaves that feed, taking its photos with it, and its agent and
  office too if it was their only one there. Polling cannot report that. A consumer
  reconciles by reading current keys. A listing entering the feed is a change to it,
  so a poll reports it.
- **One feed for each consumer.** Staff choose the feed when adding a data consumer;
  nothing is chosen for them. It is not changed afterwards: to change it, revoke the
  consumer and add another, so a token never changes what it can read. Each request
  is logged with the feed that answered. On upgrade, existing consumers are on the
  full feed, which is what they already read.

**File export.** From a search, a member exports the listings found as a CSV file:
a header row, then one row for each listing, and nothing else.

| Kind | Columns, in this order |
| --- | --- |
| Client export | ListingId, StandardStatus, PropertyType, ListPrice, ClosePrice, CloseDate, UnparsedAddress, City, StateOrProvince, PostalCode, BedroomsTotal, BathroomsTotalInteger, LivingArea, LotSizeAcres, YearBuilt, PublicRemarks, ListAgentFullName, ListOfficeName |
| Agent export | The client export's columns, then OriginalListPrice, CountyOrParish, ParcelNumber, DaysOnMarket, CumulativeDaysOnMarket |

- **The client export is a client copy as a file**: the same rule builds it, so it
  holds the four client-copy statuses, and a sale price and date only for a sale.
- **Never in a file**, of either kind: showing instructions, lock box details,
  documents, history, flags, keys, and photo addresses. That is stricter than a
  printed agent copy, which gives showing details to members allowed to see them: a
  file travels further than a page.
- **Which listings.** A search reads at most 100 listings, in its order, and says
  whether there were more; it does not count them, and neither does the export. The
  file is made from those listings and no others. For a client export, listings in
  other statuses are then left out, so it can hold fewer than 100 while more
  eligible listings lie beyond the first 100.
- **What is disclosed.** Before the download, the export page states how many
  listings the file holds, how many were left out of a client export for their
  status, and, when the search was cut off, that the rest were not considered and
  that their number is not known. The file's name gives its kind, the number of
  listings, and the date.
- **Who.** Any active member. Each download is recorded with who, when, which kind,
  the search, and those figures. Looking at the export page records nothing.
- **Safety.** UTF-8. Text a spreadsheet would run as a formula is given a leading
  apostrophe so that it is shown and not run.

**RESO's certification tool, on each feed.** Run locally on 2026-11-20, version
0.13.1, on the code at commit `3cb4a58`, with the same limits as before: not a
certification, variations not checked, plain HTTP, and small synthetic data.

| Feed | Web API Core 2.1.0 | Data Dictionary 2.1, strict |
| --- | --- | --- |
| Full | 153 passed, 0 failed, 173 skipped; 18 optional scenarios not supported | 6 steps passed, 1 skipped; 756 records; 49 warnings |
| Public display | 147 passed, 0 failed, 179 skipped; 18 optional scenarios not supported | 6 steps passed, 1 skipped; 570 records; 32 warnings |

The six scenarios the public display feed skips and the full feed passes are the
lookup tests on Member and Office. In that feed neither resource has a field that
holds one of a list of values, so there is nothing for those tests to run on: they
are tests that do not apply, not failures and not passes. A feed's fields are a
disclosure decision and are not widened to make a test run.

Not included: feeds defined by staff, a choice of fields for one consumer, exports
of collections or single listings, other file formats, scheduled or emailed exports,
and an exact count of a search that was cut off.

## Importing new listings

Staff who hold "Import listings"
load new listings from a CSV file, at **Imports** in the page header.

**What it cannot do.** OSMLS can support evaluation and new listing entry, but
this importer cannot migrate an existing MLS's historical records. It cannot bring
in closed or ended listings, past status or price changes, or earlier dates, and it
never changes a listing that already exists. Migrating a real MLS's history is
deferred; it would need rules written against that MLS's own data.

- **Each imported listing is an ordinary new listing.** It is checked by the entry
  form's own validation, starts as Coming Soon or Active, is dated when the import
  is committed, and gets the ordinary first history entry. There is one place a
  listing is created, used by the entry form and by an import alike.
- **The file.** CSV, UTF-8, a header row, up to 500 rows. Each column is named
  exactly as the Data Dictionary field it fills: the fields of the entry form, plus
  `ListAgentMlsId` (the listing agent's member ID) and `SourceListingId` (the
  listing's identifier where it came from). There is no mapping screen. A column
  that is not on the list, a column given twice, or a required column missing
  refuses the whole file, so nothing is silently ignored. Photos, documents and
  listing numbers are not imported.
- **The listing agent.** Staff import on behalf of agents. Each row names its
  agent, who must be an active agent in an active office. The listing is that
  agent's, and its history records the staff member who imported it, the import,
  and the row.
- **Preview, then commit.** Uploading creates nothing. Staff see what each row
  would do: be created, be refused and why (every problem, not only the first), or
  be left out as a possible duplicate. A file with refused rows can still be
  committed.
- **A commit creates exactly the rows the preview accepted, or nothing.** Every row
  is judged again when the import is committed, inside one transaction. If a row
  that was going to be created no longer passes (its agent was suspended, say),
  nothing is created and the preview is brought up to date. A row the preview did
  not accept is never created, even if it would pass by then. A preview is
  committed once.
- **Duplicates.**

  | Case | What happens |
  | --- | --- |
  | The same source identifier twice in one file | Both rows refused |
  | A source identifier already imported from the same source | Refused, so a file loaded twice creates nothing the second time |
  | Two rows of one file for the same property | Both left out |
  | The same property as a listing that has not ended | Left out |

  The source's name is compared without regard to capitals or spacing. "The same
  property" is the parcel and address matching used for days on market, with its
  limits: a property typed differently is not recognised.
- **Imports and hand entry take turns.** Creating a listing first takes a lock on
  the property it is for, whether from the form or from an import, so a listing
  entered by hand cannot arrive between an import's check and its write. Nothing
  else about hand entry changes: an agent can still enter another listing for a
  property that has one.
- **What is kept.** The record of an import is permanent: who, when, the source,
  the file's name and hash, each row's outcome, and the listing each created. What
  the rows held is not kept once the import is committed. A preview that is not
  committed can no longer be opened or committed after 24 hours; what it held is
  deleted by the next run of the scheduled command (`pnpm alerts:send`), so it can
  remain stored, unreachable, until that runs.
- **Alerts.** Imported listings are new listings, so they appear in saved-search
  activity and alerts like any other.

Not included: updating existing listings; migrating history, closed listings or
earlier dates; importing photos, documents, members or offices; writing through the
API; scheduled imports; a column-mapping screen; and Excel files.
