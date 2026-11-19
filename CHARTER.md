# OSMLS Charter

OSMLS: an open-source MLS platform created by Daniel P. Harris.

This file records what the project is for, what has been decided, what each release
covers, and what has and has not been done. "Maintainer" means Daniel P. Harris.

## Status

**Version 0.1 is an early release that runs on synthetic data. It is not
production-ready.**

- Implemented: every item in the version 0.1 scope (section 5).
- Tested: 26 automated tests of rules, validation, and database behaviour, and one
  browser test of the whole workflow, pass against both the development server and
  the Docker Compose build.
- Installation: a fresh clone followed the README with an uncached Docker build on
  the machine it was developed on (macOS). The Docker demo started and seeded, and
  the developer setup passed lint, type-check, all tests, and the browser test.
  This does not establish that it works in other environments.
- Release review: no credentials or personal data in the repository; all demo data
  is synthetic; dependencies are under permissive licenses (one LGPL image library
  is pulled in by Next.js and is not redistributed here); two known advisories
  affect development tools only, not the running application.
- Not tested: other machines or operating systems, browsers other than Chromium,
  phone-sized screens, and RESO's certification tests (there is no Web API endpoint
  to test). There has been no security review.
- Map search (roadmap item 1) is implemented on top of 0.1: pinning a listing,
  results on a map, and searching the visible map area. Tested by 45 automated
  tests and 3 browser tests, which use a blank local map style. The default map
  service was checked by hand in a production build at desktop and phone widths,
  in Chromium only.
- Documents and showing instructions (roadmap item 1 after map search) are
  implemented, with access rules for each. Tested by unit tests of every
  combination of viewer and permission or status, database tests, and a browser
  test that checks what each kind of viewer is actually sent, including by direct
  request. Uploaded files are not scanned for malware, and keeping entry codes out
  of the system is a usage restriction, not a guarantee.
- Market research is implemented: sold search, days on market and cumulative days
  on market, a member timeline, and comparables. The market-time rules are six
  settings with defaults, not a standard; changing one takes a redeployment and
  recalculates past figures. Every worked example from the design is a test, each
  setting has a test showing it changes the result, and a browser test covers the
  screens against seeded data. Comparables are not a valuation.
- Deployed: nowhere. There is no hosted instance.

## 1. Purpose

- Provide a focused, openly licensed core MLS that organizations and developers can
  inspect, run, adapt, and learn from.
- Show in working code how the essentials of an MLS fit together: listing data,
  rules, permissions, and accountability.
- Be a place for people in MLS and real estate technology to collaborate.
- Not built primarily for profit. Adoption by an MLS is welcome but is not something
  the project depends on.
- The code is free to use under an open-source license. Hosting, implementation,
  maintenance, and support remain the cost of whoever runs it.
- The project should be worthwhile even with a single contributor.

## 2. Product direction

- A focused core MLS covering what people need for everyday work.
- No pursuit of feature parity with Matrix or Flexmls.
- Working, integrated workflows over a broad set of unfinished features.
- Local fields and operating rules configurable where practical.
- Responsive web application. No native mobile apps initially.

## 3. Core categories

The exact feature list per release is not final, and "most-used features" has not
been validated against usage data.

| Area | Capabilities |
| --- | --- |
| Listing management | Enter and edit listings; photos and documents; price and status updates through closing. |
| Property search | Field-based and map-based search: address, listing number, location, price, characteristics, status. |
| Listing review | Photos, details, agent information, showing instructions, documents, with access restrictions. |
| Market research | Sold and off-market records, price/status history, DOM/CDOM, basic comparables. |
| Saved work and sharing | Saved searches, listing collections, email sharing, printable reports. |
| Alerts | New-listing and listing-change notifications; recent market activity. |
| Administration | Members, brokerages, offices, roles, permissions, access suspension. |
| Data integrity | Required fields, validation, permitted status changes, consistent calculations. |
| Accountability | Change histories (who, what, when); authorized staff corrections. |
| Basic compliance workflow | Flag listing problems and track their resolution. |
| Data exchange | Authorized imports, exports, controlled distribution; RESO interoperability as a design requirement. |
| Operations | Security, monitoring, backups, recovery, manageable updates. |

## 4. Deferred

- Elaborate CMA presentations.
- CRM and marketing automation.
- Full client collaboration portals.
- AI assistants and automated valuations.
- Advanced analytics dashboards.
- Built-in showing scheduling and transaction management.
- Public consumer and agent websites.
- Native mobile apps.
- Elaborate fine-processing functionality.

Basic listing emails and shareable pages cover initial client delivery.

## 5. Version 0.1 scope

One workflow, complete and tested: **an agent creates a listing, another agent finds
it, and MLS staff inspect its history.**

In scope:

- Sign-in with three roles: listing agent, agent, MLS staff. Members, brokerages,
  and offices come from seeded synthetic data; there is no administration screen.
- Listing entry and editing with a core field set named after the RESO Data
  Dictionary, required fields, and validation.
- Status and price changes, limited to permitted status transitions.
- Basic photo upload. A listing demo without photos is not credible.
- Field-based search: address, listing number, city or postal code, price range,
  beds, baths, status.
- Listing detail view.
- Change history on every listing recording who changed what and when, visible to
  MLS staff, including staff corrections recorded as such.
- Synthetic demo data, automated tests for the workflow, setup documentation, and
  contribution instructions.

Out of 0.1, planned for later releases (see section 10):

- Map search (since added; see section 10).
- Documents and showing instructions (since added; see section 10).
- Sold-record research, DOM/CDOM, comparables (since added; see section 10).
- Saved searches, collections, email sharing, reports, alerts.
- Administration screens and access suspension.
- Compliance flags.
- Imports, exports, and a RESO Web API endpoint.
- Production operations: monitoring, backups, recovery.

## 6. License and repository

- License: Apache-2.0. Permissive, includes a patent grant, and familiar to the
  vendors and MLS organizations the project is meant to reach.
- Location: a public repository named `OSMLS` under the GitHub account
  `DanielPHarris`. It can move to an organization later without losing history.

## 7. Technical foundation

The stack was chosen after one evaluation, on 2026-11-18, that covered RESO's
toolkit and Data Dictionary.

### 7.1 Findings on RESO's tooling (2026-11-18)

- RESO publishes its tools at tools.reso.org and github.com/RESOStandards/reso-tools.
  They are TypeScript on Node.js 22+: a certification command-line tool
  (`reso-cert`), a metadata-driven reference server (Express, PostgreSQL, React),
  validation and OData parsing libraries. They are under active release; the latest
  listed were dated 2026-11-15.
- The reference server implements Data Dictionary 2.0 and Web API Core 2.1.0, with
  Add/Edit and EntityEvent.
- Data Dictionary edition (researched 2026-11-18): RESO certifies on 2.1, which was
  approved on October 5, 2026. Its certification tool treats 2.1 as the default
  and the only edition that certifies; a 2.0 run is a retest. The page on reso.org
  that still names 2.0 is out of date. RESO's policy is to certify on the latest
  minor edition, and a 2.2 release has been approved for the end of 2026.
- **The tools are not open source.** The repository's LICENSE is the RESO End-User
  License Agreement, not an open-source license. It grants a royalty-free license to
  use the standard inside one's products, bars redistributing it unaltered as a
  standalone product, grants no trademark license for "RESO", and does not address
  open-source redistribution. Membership and fees are not required by its text.
- Unknown: whether RESO's Data Dictionary metadata file may sit in an Apache-2.0
  repository, and what wording about RESO the project may use. The EULA is silent.
  This is a legal question; the reading above is not legal advice.

### 7.2 Stack

- **Language and runtime:** TypeScript on Node.js 22 or later, the same as RESO's
  tools, so their validators and certification tool can be run against OSMLS.
- **Application:** one Next.js web application serving both the screens and the
  server logic. No separate services in 0.1.
- **Database:** PostgreSQL, with SQL migrations kept in the repository. It is what
  RESO's reference server uses by default, and PostGIS covers map search later.
- **Change history:** an append-only audit table written in the same database
  transaction as every listing change, so a change cannot exist without its record.
- **Sign-in:** a self-hosted library inside the application, not a hosted identity
  service, so anyone can run OSMLS without third-party accounts.
- **Photos:** stored on local disk in 0.1.
- **Maps:** MapLibre GL JS, with the map source set by one MapLibre-compatible
  style URL. The default is OpenFreeMap's public service, which has no availability
  guarantee and may be discontinued without notice, so it is a demo default only.
  Listing locations are plain latitude and longitude columns. PostGIS is deferred
  until polygons or radius search are taken up; the effort to migrate will be
  assessed then.
- **Running it:** Docker Compose starts the application and database with synthetic
  data in one command. No dependency on any one hosting provider.
- **Tests:** unit tests for validation and status rules, plus one browser test that
  runs the whole 0.1 workflow.

### 7.3 How OSMLS relates to RESO

- Name fields and lookup values after the edition of the Data Dictionary that RESO
  currently certifies. That is 2.1.
- Do not copy RESO's code or metadata file into the repository. Do not build on the
  reference server.
- Use RESO's certification tool as an external check once OSMLS has a Web API
  endpoint, which is after 0.1.
- Describe the project factually ("field names and lookup values follow the RESO
  Data Dictionary 2.1"), with no RESO logo and no certification claim.
- The repository contains none of RESO's code or files, uses no RESO logo, and
  claims no certification, so neither unknown in 7.1 applies to what is published.
- Resolved 2026-11-18: OSMLS was first built against 2.0. Every field name and lookup
  value it uses was then compared with the 2.1 reference and is the same in both,
  so no code changed. The fields that 2.1 renamed are not ones OSMLS uses. 2.1 adds
  a tenth property type, "Commercial Real Estate", which OSMLS does not offer.
- Not verified: data types against the Data Dictionary, and whether OSMLS would
  pass RESO's certification tests. Both wait for the Web API work (section 10).

Considered and not recommended: Python with Django, which provides sign-in,
administration screens, and history with less code but puts OSMLS on a different
runtime from RESO's tools; and forking RESO's reference server, which its license
does not clearly allow.

## 8. AI and legal boundaries

- Fair housing and licensing considerations belong in the core design.
- AI may assist licensed professionals; professional judgment and responsibility
  stay with them.
- AI must not independently represent clients or perform restricted brokerage
  activities.
- Consequential actions need authorization, permissions, and audit records.
- Routine user-configured automation, such as listing alerts, may run automatically.
- Restrictions are enforced in the application, not only in chatbot instructions.
- Human review alone does not establish legal compliance.
- No AI feature is needed for the initial core product.

## 9. Public credibility

- The repository is public and welcomes contributions. See CONTRIBUTING.md.
- Attribution to the creator stays clear.
- Capabilities, testing, and limitations are documented honestly.
- No claim of production readiness or RESO certification unless established.

## 10. Roadmap

Done:

- Charter, scope, license, and stack decided (2026-11-18).
- Version 0.1 workflow built and tested (2026-11-18).
- Map search within the visible map area (2026-11-18). Drawing shapes, radius
  search, and automatic geocoding are not included.

- Listing documents and showing instructions, with access controls (2026-11-18).
  Not included: malware scanning, version retention, a download log, entry codes,
  and sharing outside the membership.

- Market research: sold search, days on market, and comparables (2026-11-19). Not
  included: any estimate of value, CMA reports, market statistics, non-MLS sales
  data, policies that take effect from a date, and a tool to link or unlink
  relistings by hand.

Next, in this order unless contributors and the maintainer agree otherwise:

1. Saved searches, collections, email sharing, reports, alerts.
2. Administration screens and access suspension. Finer-grained staff permissions
   belong here, as would changing market-time settings without a redeployment.
3. Compliance flags. A tool to correct a wrongly linked relisting belongs here.
4. Imports, exports, and a RESO Web API endpoint, checked with RESO's certification
   tool. Any export must apply the document and showing access rules.
5. Production operations: monitoring, backups, recovery.

Fair-housing considerations (section 8) are a design requirement and are not yet
implemented in any feature.
