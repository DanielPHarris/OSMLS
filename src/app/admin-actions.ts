"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions";
import { createDataConsumer, revokeDataConsumer } from "@/lib/data-exchange";
import { commitImport, previewImport } from "@/lib/imports";
import { ListingError } from "@/lib/listings";
import { changeMemberEmail, createMember, moveMember, sendPasswordLink, setCapabilities, setMemberStatus, setPasswordWithLink, updateMember } from "@/lib/members";
import { createOffice, setMainOffice, setOfficeStatus, updateOffice } from "@/lib/offices";
import { getCurrentMember } from "@/lib/session";
import { saveMarketTimeSettings } from "@/lib/settings";

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

export async function moveMemberAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await moveMember(current, key, formData.get("officeKey"), formData.get("reason"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Moved. Their listings keep the office recorded on them." };
}

export async function setCapabilitiesAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await setCapabilities(current, key, formData.getAll("capability"), formData.get("reason"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Capabilities saved. They apply from this member's next action." };
}

export async function saveSettingsAction(basedOn: number, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await saveMarketTimeSettings(
      current,
      {
        accumulatingStatuses: formData.getAll("accumulatingStatuses"),
        relistingGapDays: formData.get("relistingGapDays"),
        brokerageChangeResets: formData.get("brokerageChangeResets") != null,
        addressFallback: formData.get("addressFallback") != null,
        gapEndpoint: formData.get("gapEndpoint"),
        timeZone: formData.get("timeZone"),
      },
      basedOn,
      formData.get("reason"),
    );
  } catch (err) {
    return failure(err);
  } finally {
    // Also after a refusal: a save refused as out of date must show the current values.
    revalidatePath("/", "layout");
  }
  return { ok: true, message: "Settings saved. Every figure is now worked out with them." };
}

export type DataConsumerFormState = FormState & {
  /** The new bearer token. It is shown this once and cannot be read back later. */
  token?: string;
};

export async function createDataConsumerAction(_previous: DataConsumerFormState, formData: FormData): Promise<DataConsumerFormState> {
  const current = await getCurrentMember();
  let made: Awaited<ReturnType<typeof createDataConsumer>>;
  try {
    made = await createDataConsumer(current, { name: formData.get("name"), feed: formData.get("feed"), expiresInDays: formData.get("expiresInDays") });
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, token: made.token, message: `${made.consumer.ConsumerName} was added.` };
}

export async function revokeDataConsumerAction(key: string): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await revokeDataConsumer(current, key);
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Revoked. Its token is refused from now on." };
}

export async function previewImportAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  const file = formData.get("file");
  let made: Awaited<ReturnType<typeof previewImport>>;
  try {
    made = await previewImport(current, {
      sourceName: formData.get("sourceName"),
      fileName: file instanceof File ? file.name : undefined,
      text: file instanceof File ? await file.text() : undefined,
    });
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  redirect(`/admin/imports/${made.ImportKey}`);
}

export async function commitImportAction(key: string): Promise<FormState> {
  const current = await getCurrentMember();
  let outcome: Awaited<ReturnType<typeof commitImport>>;
  try {
    outcome = await commitImport(current, key);
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  if (outcome.stale) {
    return { message: "Nothing was created. A row that was going to be created no longer passes, so the preview has been brought up to date. Look at it again before committing." };
  }
  return { ok: true, message: `${outcome.created} ${outcome.created === 1 ? "listing was" : "listings were"} created.` };
}

export async function createOfficeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  const values: Record<string, string> = {};
  for (const [name, value] of formData) if (typeof value === "string") values[name] = value;
  let made: Awaited<ReturnType<typeof createOffice>>;
  try {
    made = await createOffice(current, values);
  } catch (err) {
    return failure(err, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `${made.OfficeName} was added.` };
}

export async function updateOfficeAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  const values: Record<string, string> = {};
  for (const [name, value] of formData) if (typeof value === "string") values[name] = value;
  try {
    await updateOffice(current, key, values);
  } catch (err) {
    return failure(err, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved." };
}

export async function setMainOfficeAction(key: string, _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await setMainOffice(current, key, formData.get("mainOfficeKey"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Brokerage saved." };
}

export async function setOfficeStatusAction(key: string, status: "Active" | "Inactive", _previous: FormState, formData: FormData): Promise<FormState> {
  const current = await getCurrentMember();
  try {
    await setOfficeStatus(current, key, status, formData.get("reason"));
  } catch (err) {
    return failure(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: status === "Inactive" ? "Office deactivated." : "Office reactivated." };
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
