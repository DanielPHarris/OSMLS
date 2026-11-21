/*
 * The scheduled command: sends saved-search alerts that are due, and deletes
 * client addresses, link records, and uncommitted import previews that are past
 * keeping. Run it as often as
 * alerts should be checked for, for example hourly. A second copy started while
 * one is running does nothing.
 */
import { pool } from "../src/db";
import { sendDueAlerts } from "../src/lib/alerts";
import { cleanUpImports } from "../src/lib/imports";
import { cleanUpShares } from "../src/lib/shares";

const alerts = await sendDueAlerts();
console.log(alerts.busy ? "Alerts: another run is in progress; nothing done." : `Alerts: ${JSON.stringify(alerts.outcomes)}`);
const links = await cleanUpShares();
console.log(`Links: ${links.addressesDeleted} expired addresses deleted, ${links.recordsDeleted} old records deleted.`);
const imports = await cleanUpImports();
console.log(`Imports: ${imports.previewsDeleted} uncommitted previews deleted.`);
await pool.end();
