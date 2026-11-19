import { redirect } from "next/navigation";
import { openSavedSearch } from "@/lib/saved-work";
import { criteriaToParams } from "@/lib/search-criteria";
import { getCurrentMember } from "@/lib/session";

/*
 * Running a saved search sends the member to the ordinary search page with the
 * saved criteria. Someone else's saved search answers exactly like one that does
 * not exist.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const current = await getCurrentMember();
  if (!current) redirect("/sign-in");
  const { key } = await params;
  const opened = await openSavedSearch(current, key);
  if (!opened) return new Response("Not found", { status: 404 });
  const address = criteriaToParams(opened.criteria);
  address.set("saved", opened.savedSearch.SavedSearchKey);
  // Tells the search page to say which criteria, if any, had to be dropped.
  address.set("ran", "1");
  redirect(`/search?${address}`);
}
