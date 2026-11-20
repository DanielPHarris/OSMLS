import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { formatDateTime } from "@/lib/format";
import { requireMember } from "@/lib/session";
import { ACCUMULATING_CHOICES, MAX_RELISTING_GAP_DAYS, SETTING_LABELS, getSettingsForAdmin, getSettingsHistory } from "@/lib/settings";
import { saveSettingsAction } from "../../admin-actions";

export default async function SettingsPage() {
  const current = await requireMember();
  // Null for anyone who does not manage settings: the screen does not exist for them.
  const settings = await getSettingsForAdmin(current);
  if (!settings) notFound();
  const history = (await getSettingsHistory(current)) ?? [];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Market-time settings</h1>
        <p className="text-sm text-muted">
          How days on market are counted, and when a relisting continues an earlier listing&rsquo;s count. These are this
          MLS&rsquo;s policy, not a standard.
        </p>
      </div>

      <section className="card space-y-3" aria-labelledby="settings-heading" data-testid="settings-form">
        <h2 id="settings-heading" className="text-base font-semibold">
          In force: version <span data-testid="settings-version">{settings.version}</span>
        </h2>
        <ActionForm action={saveSettingsAction.bind(null, settings.version)} className="space-y-4">
          <fieldset>
            <legend className="label">{SETTING_LABELS.accumulatingStatuses}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {ACCUMULATING_CHOICES.map((status) => (
                <label key={status} className="flex items-center gap-1">
                  <input type="checkbox" name="accumulatingStatuses" value={status} defaultChecked={settings.accumulatingStatuses.includes(status)} />
                  {status}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">In every other status the count is paused. A listing that has ended cannot gain days.</p>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="label">
              {SETTING_LABELS.relistingGapDays}
              <input name="relistingGapDays" type="number" min={0} max={MAX_RELISTING_GAP_DAYS} step={1} required defaultValue={settings.relistingGapDays} className="field" />
              <span className="text-xs font-normal text-muted">A relisting continues the earlier count only if fewer days than this passed.</span>
            </label>
            <label className="label">
              {SETTING_LABELS.gapEndpoint}
              <select name="gapEndpoint" defaultValue={settings.gapEndpoint} className="field">
                <option value="entered">When the new listing was entered</option>
                <option value="onMarket">When the new listing first went on the market</option>
              </select>
            </label>
            <label className="label">
              {SETTING_LABELS.timeZone}
              <input name="timeZone" required maxLength={64} defaultValue={settings.timeZone} className="field" />
              <span className="text-xs font-normal text-muted">
                An IANA name. It also decides calendar dates elsewhere in OSMLS, such as the date a listing went on the
                market. Dates and times already stored are not rewritten.
              </span>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="brokerageChangeResets" defaultChecked={settings.brokerageChangeResets} />
            {SETTING_LABELS.brokerageChangeResets}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="addressFallback" defaultChecked={settings.addressFallback} />
            {SETTING_LABELS.addressFallback}
          </label>
          <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="recalculation-notice">
            A change recalculates days on market and cumulative days on market for every listing, past and present, as soon
            as it is saved. Earlier figures are not kept.
          </p>
          <label className="label block">
            Reason for the change
            <textarea name="reason" required maxLength={500} rows={2} className="field w-full" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirm" required />I understand this changes the figures shown for past listings.
          </label>
          <button className="btn">Save settings</button>
        </ActionForm>
      </section>

      <section className="card overflow-x-auto" aria-labelledby="settings-history-heading">
        <h2 id="settings-history-heading" className="mb-3 text-base font-semibold">
          Change record
        </h2>
        <table className="w-full border-collapse text-sm" data-testid="settings-history">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-3">Version</th>
              <th className="py-2 pr-3">When</th>
              <th className="py-2 pr-3">What changed</th>
              <th className="py-2 pr-3">By</th>
              <th className="py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.version} className="border-b border-line align-top last:border-0">
                <td className="py-2 pr-3">{entry.version}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(entry.at)}</td>
                <td className="py-2 pr-3">
                  {entry.changes.length === 0
                    ? "Starting values"
                    : entry.changes.map((c) => (
                        <div key={c.label}>
                          {c.label}: {c.previous} → {c.next}
                        </div>
                      ))}
                </td>
                <td className="py-2 pr-3">{entry.by ?? "Installation"}</td>
                <td className="py-2">{entry.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
