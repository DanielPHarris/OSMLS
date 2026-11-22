# Administration

What MLS staff do in OSMLS: manage members and offices, hold separate permissions, set how market time is counted, and review compliance flags.

[Back to the README](../README.md)

## Member administration and access suspension

MLS staff can add a member, change
a member's details and role, and suspend or reinstate a member's access, at
**Members** in the page header. Offices and brokerages, and staff permissions, are described below.

- **Who may.** Staff who hold "Manage members", for agents; staff accounts take
  "Manage staff" (see staff permissions below). For anyone else these pages and
  actions answer "not found".
- **Adding a member.** Name, email, member ID, role, phone, and for an agent an
  office. The member record and the sign-in identity are made together or not at
  all. There is still no public sign-up.
- **Passwords.** Staff never choose or see one. A new member is emailed a link to
  set their own: it works once, for 24 hours, and only a hash of it is stored.
  Staff can have a new link sent; it is always a new link and ends the earlier
  one. Using a link ends the member's other sessions. With email off, the link is
  shown once to the staff member to pass on. There is no self-service "forgot
  password".
- **Changing an email** changes the sign-in address with it, and ends any password
  link already sent, since that went to the old address. Making a link and changing
  an email are taken one at a time for each member, so a link is always for the
  address the member has when it is made, and only the newest link works.
- **Role and office.** Making a member an agent needs an office; making one MLS
  staff removes it. Moving an agent between offices is described below. A listing
  keeps the office recorded on it whatever happens to its agent.
- **Suspension.** Needs a reason. It denies access through every session the
  member has, at once; it does not delete those sessions, so reinstating restores
  access without a new sign-in. A suspended member can still sign in and is then
  refused everything. A change to a listing, a photo or a document
  that is under way at that moment goes one of two ways. If the suspension is
  recorded first, the change is refused and saves nothing. If the change has
  already reached the point of saving, it finishes, and the suspension waits
  for it and takes effect immediately after. A suspension never lands in the
  middle of a change. Their
  client links and photos stop working and their email alerts stop. Nothing of theirs is deleted, and reinstating restores it all.
- **Guards.** A staff member cannot suspend themself or change their own role.
  Every change to anyone's status or role is taken one at a time across the MLS,
  and the acting member's own authority is checked again inside that turn, so two
  staff who suspend each other at the same moment cannot both succeed.
- **The record.** Every administrative change is recorded with who made it, the
  old and new value, when, and the reason where one is required. Staff can read it
  on the member's page. Passwords and password links are never written to it.
- **No deletion.** A member is suspended, never removed, because history refers to
  them.


## Offices and brokerages

MLS staff can add an office,
change its details, group offices into a brokerage, deactivate and reactivate an
office, and move an agent from one office to another, at **Offices** in the page
header and on each member's page.

- **Who may.** Staff who hold "Manage offices".
- **A brokerage is a main office and its branches**, one level deep. A branch's
  main office must itself be a main office, an office with branches cannot become
  a branch, and an office cannot be its own main office.
- **Grouping changes no one's access.** Office-only documents and showing details
  stay with the one office named on a listing, not its brokerage.
- **An active agent is always in an active office.** An office with active agents
  cannot be deactivated; staff move or suspend them first. An inactive office
  cannot be given an agent by any route: adding a member, making MLS staff an
  agent, moving an agent, or reinstating one. A suspended agent can be moved, so
  that they can then be reinstated.
- **An active branch always has an active main office.** A main office with active
  branches cannot be deactivated, and an active branch cannot be added under,
  moved under, or reactivated under an inactive main office.
- **Moving an agent** needs a reason. Their listings keep the office recorded on
  them and they remain the listing agent. What the old office's membership let
  them see of colleagues' listings goes on their next request, including in a
  session already open, and the new office's comes. Saved work, client links, and
  alerts are untouched.
- **Reasons and the record.** Deactivating, reactivating, and moving each need a
  reason. Every change to an office is recorded with who, what, and when, and is
  shown on the office's page; a move is recorded on the member.
- **One at a time.** Every change to an office's status or brokerage, and every
  move and reinstatement, takes the same MLS-wide turn as status and role changes,
  so each rule is checked against a state nothing else is changing. Tests race a
  move, a reinstatement, and a regrouping against a deactivation.
- **No deletion.** Listings and history refer to offices.

Not included: brokerage-wide access, broker or office-manager roles, moving
listings between offices, bulk moves, and licence or membership data.

## Staff permissions and market-time settings

**Staff permissions.** Administration is divided into capabilities, each held
by individual staff accounts:

| Capability | Allows |
| --- | --- |
| Manage members | Add, edit, suspend, reinstate and move agents; change their email; send them password links |
| Manage offices | Add, edit, deactivate and reactivate offices; group them into brokerages |
| Manage settings | Change the market-time settings |
| Manage compliance | See and close flags, and say which earlier listing a listing continues (see compliance flags, below) |
| Manage data access | Add and revoke the outside systems that may read the data exchange feed (see the [data exchange guide](data-exchange.md)) |
| Import listings | Load new listings from a file on behalf of agents (see [importing new listings](data-exchange.md#importing-new-listings)) |
| Manage staff | Add staff accounts, change a role to or from staff, grant and revoke capabilities, and do any member action to a staff account |

- **They divide administration and nothing else.** Every active staff account can
  still correct any listing and see all documents and showing instructions, as
  before.
- **Managing members is not managing staff.** Someone who holds only "Manage
  members" cannot add a staff account, change a role to or from staff, or edit,
  suspend, change the email of, or send a password link to a staff account. So
  they cannot take one over.
- **Granting.** Only a holder of "Manage staff" grants or revokes, on the staff
  member's page, with a reason, and it is written to that member's change record.
  A new staff account starts with none. Making staff an agent takes theirs away.
- **Only on an active staff account.** A capability recorded on an agent or on a
  suspended account allows nothing.
- **Decided inside the operation.** Who is acting and what they are acting on
  are both read again inside the protected step, not taken from what the request
  saw. An agent who became staff while an email change for them was waiting is
  treated as staff; a capability revoked while an action was waiting refuses it.
  A revocation applies to a session already open at its next action.
- **Someone can always manage staff.** The last active account holding "Manage
  staff" cannot give it up, be suspended, or be made an agent, including when two
  such changes are made at the same moment. An administrator may give up their
  own while another remains.
- **Upgrading.** Every existing staff account, active or suspended, is given the
  four capabilities above other than "Manage compliance", so nothing changes
  until someone narrows it.

**Market-time settings.** Staff who hold "Manage settings" change the six settings
at **Settings** in the page header. No redeployment or restart is involved.

- **Limits.** At least one status must gain days, chosen from the standard
  statuses other than Closed, Canceled, Expired and Withdrawn. The relisting gap
  is a whole number from 0 to 365. The time zone is an IANA name. These limits are
  OSMLS's choices.
- **The record.** Each save needs a reason and is kept as a new version with who
  made it, when, and the old and new value of each setting changed. Earlier
  versions are never altered. The screen shows them all.
- **Two people editing.** A save made from a version that is no longer in force is
  refused, and the current values are shown.
- **It recalculates the past.** A saved change applies to every listing, past and
  present, from the next page or run. Figures are not stored, so there is one
  policy at a time: no effective dates, and no record of what a figure used to be.
  The screen says this, and asks for confirmation, before saving.
- **One version per operation.** A page, an action, and the scheduled alert run
  each use one version of the settings from start to finish, whatever is saved
  meanwhile. Nothing in the application reads the starting values in code.
- **Time zone.** It also decides calendar dates elsewhere, such as the date a
  listing went on the market and the dates on a member timeline. Dates and times
  already stored are never rewritten; a new zone applies to dates worked out from
  stored times, and to dates stored from then on.
- **Alerts.** A settings change alone sends no email.

Not included: custom roles or groups, staff limited to particular offices,
permissions for agents or brokers, settings that apply from a date or differ by
office, and settings for comparables.

## Compliance flags and relisting links

The charter's "basic compliance workflow": a member flags a problem with a
listing, and MLS staff track it to a close. It is a record of reports and what
was done about them. It does not find problems by itself, and it is not legal
compliance.

**Flags.** On any listing, under **Flags**, any active member can report a
problem: a category from a fixed list (incorrect information, photos, remarks,
status not updated, duplicate listing, market time or relisting link, other) and
a description.

- **A flag changes nothing.** It does not change, hide, or penalise the listing.
  If something needs correcting, staff correct it the ordinary way, with its own
  reason and history entry.
- **Who handles them.** Staff who hold "Manage compliance" see every flag at
  **Flags** in the page header, narrowed by state, category, and listing office,
  and close each as Resolved or Dismissed with a note. A closed flag is final; a
  new problem is a new flag.
- **Who sees what.**

  | | Compliance staff | The member who raised it | Listing agent and listing office | Anyone else |
  | --- | --- | --- | --- | --- |
  | That the flag exists, its category and state | Yes | Their own | On their listing | No |
  | Description and closing note | Yes | Yes | Yes | No |
  | Who raised it | Yes | n/a | Never | No |
  | Who closed it | Yes | No | No | No |

- **Who raised it stays with compliance staff.** What the listing side is given
  is built without the reporter's name, member ID, email, or office; it is not a
  full record with parts hidden. But the description and the closing note are
  free text that the listing side reads, and nothing is redacted, so a flag is
  only as anonymous as what was typed. The form says so.
- **Limits.** One open flag per member, per listing, per category, and 20 flags
  per member per calendar day in the MLS time zone. Both hold when flags are sent
  at the same moment.
- **Not on reports.** Flags never appear on agent copies, client copies, or pages
  shared with clients.
- **No email.** Flags are seen in the application.
- **Upgrading.** "Manage compliance" is given to every account that holds "Manage
  staff".

**Relisting links.** Cumulative days on market follows the earlier listing of the
same property, found by parcel number and address. On a listing, compliance staff
can set one of three things, with a reason:

| Setting | Meaning |
| --- | --- |
| Automatic (the default) | The earlier listing is found by matching. |
| None | This listing continues no earlier listing. |
| A named listing | That listing, given by its listing number, is the earlier one. |

- **Naming a listing settles one question only:** that it is the same property.
  It is not checked against parcel, address, or the address-fallback setting, so
  it can repair a match that was missed.
- **Everything else still applies.** The relisting gap, where the gap ends, the
  brokerage rule, and how the earlier listing ended still decide whether the
  count continues. A named listing that fails them stays on record, and the count
  starts fresh.
- **Never past a sale.** If the property was sold between the two listings, the
  link is refused; if such a sale is entered later, the link stops being followed.
  The sale is recognised by matching, so if it is in truth a different property
  that was matched by mistake, correct its parcel number or address first.
- **Only an earlier listing** can be named, so a listing cannot continue itself
  and chains cannot loop.
- **It recalculates the past**, like a settings change: figures change wherever
  they are shown, from the next page or run.
- **The record.** Each change is in the listing's change history as a staff
  correction with its reason, which staff can read. Members see the resulting
  figures and which listings they include, not that staff set them.

Not included: finding problems automatically, fair-housing checks on remarks,
redacting free text, fines, deadlines, appeals, email about flags, flags on
members or offices, bulk actions, and rules that two listings are never the same
property.
