import nodemailer from "nodemailer";

/*
 * Outgoing email, through whatever SMTP server the operator names in SMTP_URL.
 * With SMTP_URL or MAIL_FROM unset, email is off and nothing here sends.
 * Every email is plain text.
 */

export const mailEnabled = (): boolean => Boolean(process.env.SMTP_URL && process.env.MAIL_FROM);

export type Mail = { to: string; replyTo?: string; subject: string; text: string; messageId?: string };

/**
 * A send that did not end in the mail server accepting the message.
 * "no": the server was never reached, or refused the message, so it was not
 * delivered. "unknown": the message was handed over and no answer came back, so
 * it may or may not have been delivered.
 */
export class MailError extends Error {
  constructor(
    public delivered: "no" | "unknown",
    cause: unknown,
  ) {
    super(delivered === "no" ? "The mail server did not take the message." : "It is not known whether the mail server took the message.", { cause });
  }
}

// What the mail library reports when the server was not reached or said no.
const REFUSED = new Set(["EDNS", "EAUTH", "EENVELOPE", "EMESSAGE", "ETLS", "EREQUIRETLS"]);
const NEVER_CONNECTED = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/;

/** Anything not recognised as a refusal is treated as unknown: the cautious reading. */
export function classifyMailFailure(err: unknown): "no" | "unknown" {
  const { code, message } = (err ?? {}) as { code?: string; message?: string };
  if (code && REFUSED.has(code)) return "no";
  if (NEVER_CONNECTED.test(`${code ?? ""} ${message ?? ""}`)) return "no";
  return "unknown";
}

/** Resolves once the mail server has accepted the message; throws MailError otherwise. */
export async function sendMail(mail: Mail): Promise<void> {
  if (!mailEnabled()) throw new MailError("no", new Error("Email is not configured."));
  const transport = nodemailer.createTransport(process.env.SMTP_URL!);
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM, ...mail });
  } catch (err) {
    throw new MailError(classifyMailFailure(err), err);
  } finally {
    transport.close();
  }
}

/** The application's own address, for links in email. */
export const appUrl = () => (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
