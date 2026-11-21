import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { DataConsumerForm } from "@/components/data-consumer-form";
import { listDataConsumers, serviceRoot } from "@/lib/data-exchange";
import { formatDateTime } from "@/lib/format";
import { FEEDS, FEED_NAMES, feedView } from "@/lib/rules/data-exchange";
import { requireMember } from "@/lib/session";
import { createDataConsumerAction, revokeDataConsumerAction } from "../../admin-actions";

export default async function DataAccessPage() {
  const current = await requireMember();
  // Null for anyone who does not manage data access: the page does not exist for them.
  const consumers = await listDataConsumers(current);
  if (!consumers) notFound();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Data access</h1>
        <p className="text-sm text-muted">
          Outside systems that may read the data exchange feed, a read-only RESO Web API at{" "}
          <code className="text-xs">{serviceRoot()}</code>. Each reads with a bearer token and is not a member.
        </p>
      </div>

      <section className="card space-y-4" aria-labelledby="served-heading" data-testid="served-fields">
        <h2 id="served-heading" className="text-base font-semibold">
          What each feed carries
        </h2>
        <p className="text-sm text-muted">
          A data consumer reads one feed, chosen when it is added and not changed afterwards; to change it, revoke the
          consumer and add another. A feed carries only the fields listed. Documents, showing instructions, lock box
          details, members&rsquo; contact details, MLS staff accounts, and change history are in no feed.
        </p>
        {FEED_NAMES.map((name) => (
          <div key={name} data-testid={`feed-${name}`}>
            <h3 className="text-sm font-semibold">{FEEDS[name].label}</h3>
            <p className="text-sm text-muted">{FEEDS[name].purpose}</p>
            <dl className="mt-2 space-y-2 text-sm">
              {feedView(name).resources.map((r) => (
                <div key={r.name}>
                  <dt className="font-medium">{r.name}</dt>
                  <dd className="text-xs text-muted">{r.fields.map((f) => f.name).join(", ")}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>

      <section className="card" aria-labelledby="add-heading" data-testid="add-data-consumer">
        <h2 id="add-heading" className="mb-3 text-base font-semibold">
          Add a data consumer
        </h2>
        <DataConsumerForm action={createDataConsumerAction} feeds={FEED_NAMES.map((name) => ({ name, label: FEEDS[name].label }))} />
      </section>

      <section className="card overflow-x-auto" aria-labelledby="consumers-heading">
        <h2 id="consumers-heading" className="mb-3 text-base font-semibold">
          Data consumers
        </h2>
        {consumers.length === 0 ? (
          <p className="text-sm text-muted">There are none.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="data-consumers">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Feed</th>
                <th className="py-2 pr-3">Added</th>
                <th className="py-2 pr-3">Expires</th>
                <th className="py-2 pr-3">Requests</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {consumers.map((c) => (
                <tr key={c.consumerKey} className="border-b border-line align-top last:border-0">
                  <td className="py-2 pr-3 font-medium">{c.name}</td>
                  <td className="py-2 pr-3" data-testid="data-consumer-feed">
                    {FEEDS[c.feed as keyof typeof FEEDS]?.label ?? c.feed}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {formatDateTime(c.createdAt)}
                    <span className="block text-xs text-muted">by {c.createdBy}</span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{c.expiresAt ? formatDateTime(c.expiresAt) : "Never"}</td>
                  <td className="py-2 pr-3">
                    {c.requests}
                    {c.lastRequestAt && <span className="block text-xs text-muted">last {formatDateTime(new Date(c.lastRequestAt))}</span>}
                  </td>
                  <td className="py-2 pr-3" data-testid="data-consumer-state">
                    {c.state}
                  </td>
                  <td className="py-2">
                    {c.state !== "Revoked" && (
                      <ActionForm action={revokeDataConsumerAction.bind(null, c.consumerKey)}>
                        <button className="btn-secondary !px-3 !py-1">Revoke</button>
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
