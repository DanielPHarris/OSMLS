# Operations

Running an OSMLS installation: backup and recovery, monitoring, and what committing listing changes one at a time was measured to cost.

[Back to the README](../README.md)

## Backup and recovery

One command backs up the
database and the photo and document files together, and another restores them.

**What this does and does not show.** There is no hosted instance. The backup and
restore mechanism is proved locally, by a drill in the test suite that destroys a
database and its files and restores them. That shows the mechanism works. It does
not show that any installation is protected: whether backups run, where they are
kept, and whether they are copied elsewhere and encrypted are for the installation
to arrange.

```bash
pnpm backup                                             # one backup, into BACKUP_DIR (default ./data/backups)
pnpm restore ./data/backups/backup-20261121T010203Z-ab12cd   # into an empty database and an empty media folder
pnpm db:migrate                                         # after a restore: brings an older backup's schema forward
```

**What is saved.** One backup is one folder: the database as one consistent
snapshot; every photo and document file that snapshot refers to; and a manifest
with the time, the application and schema versions, the number of records in each
table, and each file's size and hash.

**What is not saved, and must be kept with the backups.** The installation's
configuration, in particular `BETTER_AUTH_SECRET`. It is not in a backup, and
should be kept separately and securely. Restoring with a different one ends
everyone's session and, less visibly, stops the list of addresses that asked not to
be emailed from matching, so those people could be emailed again. `DATABASE_URL`,
`MEDIA_DIR`, and the mail settings are needed too, and can be set afresh.

**The database and the files, together.** A backup is a state the system was
actually in: every photo and document record with its file.

- The files copied are the ones the database snapshot refers to, read from that
  same snapshot.
- A file is never changed once written. Every upload goes under a new name, and
  replacing a document writes a new file.
- A file is not deleted when its record is. Files no record refers to are deleted
  only by a sweep that `pnpm backup` runs after its backup has completed.
- The application stays in use while a backup runs. There is no maintenance pause.

**What that means for deleting.** Removing a photo, or removing or replacing a
document, takes it out of the application at once: no one is served it again. Its
file stays on disk until the next backup run's sweep, and stays inside backups
until they are pruned. Deleting a document does not make it unrecoverable at once.

**Complete or not at all.** A backup is written under a name that marks it
incomplete, checked against its manifest, and only then given its final name. One
that fails part-way leaves nothing behind, is never listed or restored from, and
causes nothing to be pruned. One backup runs at a time; another started meanwhile,
and the pruning and the sweep, wait for it.

**Uploads and the sweep.** An upload holds a lock from before it writes its file
until its record is committed, and the sweep waits for that lock. So the sweep
never deletes the file of an upload still in progress, however long it takes. An
upload never waits for a backup.

**The sweep needs the media folder to be one database's alone.** The sweep
deletes every file its own database does not refer to, so if two databases used
one folder, each would delete the other's files. It therefore deletes nothing
until the folder has been given to its database:

```bash
pnpm media:claim                               # the database in DATABASE_URL, the folder in MEDIA_DIR
docker compose run --rm backup pnpm media:claim   # the same, for the Docker Compose setup
```

- Until then `pnpm backup` still takes and prunes backups, says the files were
  not swept and why, and removed files stay on disk.
- A folder given to one database cannot be given to another, is not swept by
  another, and refuses another's uploads.
- Restoring gives the restored folder to the restored database.
- The Docker Compose setup shares `./data/media` with local development, which
  uses a different database. Give the folder to one of them only if the other is
  not used, or point one of them at a folder of its own with `MEDIA_DIR`.
- The folder is tied to the database server and database name. A database moved
  to a new server other than by `pnpm restore` is a different database to this
  check: remove `.osmls-media-belongs-to` from the folder and claim it again.

**Where and how often.** `pnpm backup` writes to `BACKUP_DIR` on the same machine
and keeps the newest `BACKUP_KEEP` complete backups (14 unless set). The Docker
Compose setup runs it once a day. Copying backups off the machine and encrypting
them are not done: both are possible and are left out by choice.
Until an installation does both, losing the disk loses the backups with the data.

**What a restore loses.** Everything since the last completed backup. There is no
point-in-time recovery.

**Restoring.**

- The backup is checked against its manifest first; one that does not match, or has
  a file missing or altered, is refused.
- The database and the media folder must both be empty. Nothing is overwritten.
- A backup made at a schema this version of the application does not know (one made
  by a newer version) is refused. One made by an older version is restored as it
  was, and `pnpm db:migrate` then brings it forward.
- Afterwards the result is checked against the manifest, record for record and file
  for file.

**The tools.** Backup and restore use PostgreSQL's own `pg_dump` and `pg_restore`,
which must be of the server's major version. The Docker image has them. Where the
ones on the `PATH` are another version, as on many developers' machines, the same
tools are run from the PostgreSQL Docker image of the server's version;
`OSMLS_PG_TOOLS=path` or `=docker` settles it without looking.

Not included: copying backups off the machine, encrypting them, point-in-time
recovery, and restoring part of a backup.

## Monitoring

The installation watches itself and tells someone when something is wrong. It is
proved locally, like backup and recovery, and that is all it shows.

**What it cannot do.** It runs inside the installation and records in its
database. It cannot tell you that the machine is off, that the database is
unreachable, or that the scheduled command which does the reporting has stopped.
A monitor outside the installation is needed for those, and is not part of OSMLS.
The health checks are what it would call.

**Health checks.** Two addresses, open without sign-in, that answer only
`{"status":"ok"}` or `{"status":"not ok"}`:

| Address | Says ok when | Otherwise |
| --- | --- | --- |
| `/api/health/live` | The application process answers. It checks nothing else. | No answer |
| `/api/health/ready` | The database answers, its schema is the version this application expects, and the media folder can be written to. | 503 |

Backups are not part of "ready". An overdue backup is reported; it is no reason
to take a working application out of service.

**What is recorded.** Every run of `pnpm backup` and of the scheduled command
(`pnpm alerts:send`) records when it ran and how it ended. The scheduled command
records each of its tasks: sending alerts, tidying expired links, and tidying
import previews. One task failing does not stop the others. A run that found
another already running is recorded as skipped, and is not counted as a run.

**What is reported.** At the end of each scheduled run, these are checked and
emailed to the address in `OPS_EMAIL`:

| Condition | Begins when | Ends when |
| --- | --- | --- |
| Backup overdue | No backup has succeeded in 26 hours (`BACKUP_OVERDUE_HOURS`) | A backup succeeds |
| Backup failed | The latest backup run recorded a failure | A backup succeeds |
| Scheduled run failed | A task of the run did not finish | A later run's tasks all finish |
| Alerts failing | At least one alert email was refused, may not have arrived, was paused after repeated failures, or could not be prepared | A later run sends at least one alert with none failing |
| Media folder not writable | Photos and documents cannot be stored | They can |

- One email when a condition begins, one every 24 hours while it lasts, and one
  when it ends.
- A run whose alerts were not all sent is recorded as failed, with the counts.
- A run with no alerts to send says nothing about whether mail works, so it
  neither begins nor ends "alerts failing".
- With `OPS_EMAIL` unset, nothing is emailed; the conditions are still recorded
  and shown.
- If a report cannot be sent, it stays owed and is tried at the next run. The
  reports go through the same mail server as everything else, so if that is what
  has failed, they wait until it is back.

**What is not emailed.**

- The database is unavailable, or its schema is another version's. The scheduled
  command then runs no task, writes one error line to its log
  (`"event":"scheduled-run-refused"`), and exits with an error. What has already
  been reported is itself recorded in the database, so no email can be promised.
  The readiness check answers not ok.
- The scheduled command has stopped. Nothing is running to say so. Whether its
  last completed run is more than 2 hours old (`SCHEDULED_OVERDUE_HOURS`) is
  worked out when the status screen is opened, and shown there.

**Status screen.** Staff who hold "Manage settings" have an **Operations**
screen: what is recorded as wrong and when it was last emailed, each readiness
check, the last scheduled run with each task's outcome, the last successful
backup, and whether the media folder has been given to this database. It does
not exist for anyone else.

**Server errors.** Each server error the application did not handle writes one
line of JSON to the process log (`"event":"server-error"`): a request identifier
made by the application (never one the caller sent), the method, the route's
pattern such as `/listings/[id]`, the kind of error, and the reference shown on
the error page. That line holds no query string, form contents, address, member,
or error message. Next.js also prints the error itself to the log, as it always
has, and an error's message can quote data: treat the process log as sensitive.
Errors are not stored, counted or emailed, and shipping the log anywhere is the
installation's.

Not included: a monitor outside the installation, paging, log shipping, metrics
and dashboards, and watching disk space.

## Performance measurement

Changes to listings are committed one at a time across the whole MLS (see [saved-search activity](agent-workflows.md#saved-search-activity) for why). `pnpm measure` measures what that costs:
how many listing changes are committed a second, how long each takes, and how
long each waits for the lock that puts them in order, as the number of
simultaneous writers grows.

**These are measurements from one run on one laptop. They are not a capacity
figure for any installation, and nothing here was tuned or changed because of
them.**

**How it was measured.**

- The application's own functions for changing a price and entering a listing
  were called directly, by 1 to 64 simultaneous writers. Requests through the web
  server were not measured.
- A synthetic dataset of 10,000 listings, 200 agents and 20 offices, in a
  database the command creates and drops. It is not a model of any MLS.
- Every run started from a copy of the same dataset, with 5 seconds of warm-up
  that is not counted and 20 seconds measured. Each level was run three times.
- Each price-change writer had listings of its own, so writers did not wait on
  each other's listings.
- The application shares 10 database connections. Every level was run that way;
  16, 32 and 64 writers were also run with a connection each.
- Time waiting for the lock was recorded by a trigger that exists only in the
  benchmark's database. Before anything was measured, a change was made to wait
  for a lock held on purpose for 500 ms, and the wait recorded was 507 ms.
- All 93 runs had no failed change, and in each the changes the benchmark
  counted were the transactions, history rows and listings the database
  recorded.

**The machine.** An Apple M1 Max laptop with 10 cores and 64 GB of memory, on
its internal solid-state storage, with PostgreSQL 17.12 in Docker Desktop at its
default settings (`shared_buffers` 128MB, `synchronous_commit` on, `fsync` on).
The benchmark, the application's code and the database all ran on it.

**Price changes, run on 2026-11-21.** Median of three runs; times in
milliseconds. These figures were measured before a later fix that makes every
listing change also read and hold its member's row (see [suspension](administration.md#member-administration-and-access-suspension)).
They have not been measured again since, so they do not include that step.

| Writers | Connections | Committed a second | Time for a change, median | 99th percentile | Wait for the lock, median | 99th percentile |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 10 | 228 | 4.2 | 11.0 | 0.006 | 0.02 |
| 2 | 10 | 764 | 2.5 | 4.3 | 0.005 | 0.2 |
| 4 | 10 | 1,081 | 3.6 | 5.7 | 0.01 | 1.0 |
| 8 | 10 | 1,143 | 6.8 | 10.6 | 3.0 | 5.2 |
| 16 | 10 | 1,130 | 13.7 | 20.9 | 4.8 | 8.2 |
| 32 | 10 | 1,141 | 27.2 | 39.8 | 4.8 | 7.8 |
| 64 | 10 | 1,126 | 54.9 | 101.9 | 4.8 | 7.9 |
| 16 | 16 | 1,094 | 14.1 | 21.5 | 10.1 | 16.1 |
| 32 | 32 | 1,066 | 29.2 | 43.0 | 25.1 | 37.1 |
| 64 | 64 | 1,073 | 57.6 | 99.7 | 53.7 | 92.1 |

New listings and a mix of nine price changes to one new listing gave figures
within about a tenth of these at four writers and above. Every run, with the
lowest and highest of each three, is in
[bench/results/RESULTS.md](../bench/results/RESULTS.md).

**What the figures show, on this machine.**

- The number committed a second rose until about four to eight writers, and from
  there stayed between about 1,050 and 1,230 whatever the number of writers or
  the workload.
- Past that point more writers bought no more changes, only a longer wait for
  each: the time for one change roughly doubled each time the writers doubled.
- With 10 connections, much of the total latency occurred outside the measured
  history-lock wait. Increasing the pool shifted most of the latency into lock
  waiting without improving throughput (a median of 54 ms of 58 ms at 64
  writers), consistent with connection-pool queueing in the smaller-pool runs.
  Time waiting for a connection was not itself measured.

**What they do not show.**

- Whether the lock is what sets the ceiling. The writers and the application's
  code ran in one Node.js process, which does one thing at a time, on the same
  machine as the database. The measurement cannot tell a limit set by the lock
  from one set by that process or by the machine.
- Why one writer alone was slower for each change (4.2 ms) than each of two
  writers together (2.5 ms). This was the same in every workload and is not
  explained.
- Anything about a server. A laptop's storage and a database in Docker are not a
  hosted installation's, and no real MLS's pattern of changes is known to this
  project.
- What the lock timing changes. With one writer, 241 changes a second (224 to
  249) without it and 228 (227 to 231) with it. That is an estimate for one
  writer, not a correction for the rest: the record is written while the lock is
  held, which can lengthen the queue behind it under load.

To run it: `pnpm measure` on a machine doing nothing else. It takes about 45
minutes, works only in databases named `osmls_bench_*` on the server in
`DATABASE_URL`, and writes `bench/results/`. The checks run it small, to show
that it works and that its counts agree. They hold it to no speed.

Not included: any change to how listing changes are committed, load through the
web server, how fast searches and reports are, and a measurement on a server.
