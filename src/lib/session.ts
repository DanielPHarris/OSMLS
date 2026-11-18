import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "../db";
import { member, type Member } from "../db/schema";
import { auth } from "./auth";

/** The signed-in, active member for this request, or null. */
export const getCurrentMember = cache(async (): Promise<Member | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const [row] = await db.select().from(member).where(eq(member.OsmlsUserId, session.user.id));
  // An inactive member keeps their record but loses access.
  return row && row.MemberStatus === "Active" ? row : null;
});

export async function requireMember(): Promise<Member> {
  const current = await getCurrentMember();
  if (!current) redirect("/sign-in");
  return current;
}
