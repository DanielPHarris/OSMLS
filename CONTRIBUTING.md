# Contributing to OSMLS

Thank you for your interest. OSMLS is maintained by Daniel P. Harris, and
contributions of code, tests, documentation, and MLS domain knowledge are welcome.

## Before you start

- Read [CHARTER.md](CHARTER.md). It says what the project is for, what each release
  covers, and what is deliberately left out.
- For anything larger than a small fix, open an issue first so the approach can be
  agreed before you spend time on it.
- Features on the charter's deferred list are unlikely to be accepted for now.

## Pull requests

Use pull requests for substantive changes. Keep each pull request focused on one
coherent change that can be reviewed independently, and include review fixes in that
same pull request. Maintainers may commit small documentation-only fixes directly to
`main`.

## Setting up

Follow "Develop" in the [README](README.md).

## What a change needs

- **Tests for the behaviour you changed.** Rules and validation go in `tests/`. A
  change to the main workflow should keep `pnpm test:e2e` passing.
- **History for every listing change.** Any new way of changing a listing must write
  its `HistoryTransactional` rows in the same transaction, through
  `src/lib/listings.ts`.
- **Permission checks on the server.** Hiding a button is not access control.
- **Data Dictionary names.** New fields use the RESO Data Dictionary name where one
  exists. Anything else starts with `Osmls`. Do not copy RESO's code or data files
  into this repository; they are not open source.
- **Schema changes as migrations.** Edit `src/db/schema.ts`, run `pnpm db:generate`,
  and commit the generated SQL.
- **Synthetic data only.** Never add real listings, people, or MLS data.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass. GitHub runs them, the browser
  tests, and a production build on every pull request.

## Honesty in documentation

Describe what works, what was tested, and what was not. Do not describe OSMLS as
production-ready, compliant, or RESO certified unless that has been established.

## Licensing

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), as section 5 of that license describes.

## Security

Please do not open a public issue for a security problem. Contact the maintainer
privately through their GitHub profile.
