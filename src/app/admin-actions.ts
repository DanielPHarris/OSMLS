"use server";

import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions";
import { ListingError } from "@/lib/listings";
import { changeMemberEmail, createMember, sendPasswordLink, setMemberStatus, setPasswordWithLink, updateMember } from "@/lib/members";
import { getCurrentMember } from "@/lib/session";

/*
 * Every action asks who is signed in and hands that to src/lib/members.ts,
 * which decides whether they may. Someone who may not is answered "not found".
 */

export type MemberFormState = FormState & {
  /** A password link to pass on by hand, when it could not be emailed. Shown once. */
  link?: string;
};

function failure(err: unknown, values?: Record<string, string>): FormState {
  if (err instanceof ListingError) {
    if (err.message === "Not found.") notFound();
    return { message: err.message, errors: err.fieldErrors, values };
  }
  throw err;
}

export async function createMemberAction(_previous: MemberFormState, formData: FormData): Promise<MemberFormState> {
  const current = await getCurrentMember();
  const values: Record<string, string> = {};
  for (const [key, value] of formData) if (typeof value === "string") values[key] = value;
  let made: Awaited<ReturnType<typeof createMember>>;
  try {
    made = await createMember(current, values);
  } catch (err) {
    return failure(err, values);
  }
  revalidatePath("/", "layout");
  const { emailedTo, link } = made.passwordLink;
  return {
    ok: true,
    link: link ?? undefined,
    message: emailedTo
      ? `${made.member.MemberFullName} was added. A link to set a password was emailed to ${emailedTo}.`
      : `${made.member.MemberFullName} was added. The link to set a password could not be emailed: pass it on yourself.`,
  };
}

export async function setMemberStatusAction(key: string, status: "Active" | "Inactive", _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await setMemberStatus(current, key, status, formData.get("reason"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: status === "Inactive" ? "Access suspended." : "Access reinstated." };
}

export async function updateMemberAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  const values: Record<string, string> = {};
  for (const [name, value] of formData) if (typeof value === "string") values[name] = value;
  try {
    await updateMember(current, key, values);
  } catch (err) {
    return failure(err, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved." };
}

export async function changeMemberEmailAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await changeMemberEmail(current, key, formData.get("email"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Email changed. They now sign in with the new address, and any password link sent earlier no longer works." };
}

export async function sendPasswordLinkAction(key: string): Promise<MemberFormState> {
  const current = await getCurrentMember();
  let sent: Awaited<ReturnType<typeof sendPasswordLink>>;
  try {
    sent = await sendPasswordLink(current, key);
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return {
    ok: true,
    link: sent.link ?? undefined,
    message: sent.emailedTo
      ? `A new link was emailed to ${sent.emailedTo}. Any earlier link no longer works.`
      : "A new link was made but could not be emailed: pass it on yourself. Any earlier link no longer works.",
  };
}

/** No account is involved: holding the link staff sent is what allows it. */
export async function setPasswordAction(token: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const password = formData.get("password");
  if (password !== formData.get("confirm")) return { message: "The two passwords do not match.", errors: { confirm: "The two passwords do not match." } };
  try {
    await setPasswordWithLink(token, password);
  } catch (err) {
    if (err instanceof ListingError) return { message: err.message, errors: err.fieldErrors };
    throw err;
  }
  return { ok: true, message: "Password set. You can now sign in." };
}
