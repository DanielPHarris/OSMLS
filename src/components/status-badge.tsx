const COLORS: Record<string, string> = {
  Active: "bg-green-100 text-green-900",
  "Coming Soon": "bg-sky-100 text-sky-900",
  "Active Under Contract": "bg-amber-100 text-amber-900",
  Pending: "bg-amber-100 text-amber-900",
  Hold: "bg-slate-200 text-slate-800",
  Withdrawn: "bg-slate-200 text-slate-800",
  Closed: "bg-violet-100 text-violet-900",
  Canceled: "bg-red-100 text-red-900",
  Expired: "bg-red-100 text-red-900",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${COLORS[status] ?? "bg-slate-200"}`}>
      {status}
    </span>
  );
}
