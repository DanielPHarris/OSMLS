import { z } from "zod";
import { PROPERTY_TYPES, STANDARD_STATUSES } from "./lookups";
import {
  EARLIEST_YEAR_BUILT,
  POSTAL_CODE_PATTERN,
  STATE_OR_PROVINCE_PATTERN,
} from "./rules/local";

const blankToNull = (v: unknown) => (v == null || (typeof v === "string" && v.trim() === "") ? null : v);
const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);

const requiredText = (label: string, max = 200) =>
  z.preprocess(trimmed, z.string({ error: `${label} is required.` }).min(1, `${label} is required.`).max(max));
const optionalText = (max = 200) => z.preprocess(blankToNull, z.preprocess(trimmed, z.string().max(max)).nullable());
const isoDate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date.`)
    .refine((s) => !Number.isNaN(Date.parse(s)), `${label} must be a real date.`);
const today = () => new Date().toISOString().slice(0, 10);

export const listingInputSchema = z
  .object({
    StandardStatus: z.enum(STANDARD_STATUSES, { error: "Choose a status." }),
    PropertyType: z.enum(PROPERTY_TYPES, { error: "Choose a property type." }),
    ListPrice: z.coerce
      .number({ error: "List price must be a number." })
      .positive("List price must be greater than zero.")
      .max(99_999_999_999, "List price is too large."),
    ListingContractDate: isoDate("Listing contract date").refine(
      (s) => s <= today(),
      "Listing contract date cannot be in the future.",
    ),
    StreetNumber: requiredText("Street number", 20),
    StreetName: requiredText("Street name"),
    UnitNumber: optionalText(20),
    City: requiredText("City"),
    StateOrProvince: z.preprocess(
      (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
      z.string().regex(STATE_OR_PROVINCE_PATTERN, "Use the two-letter state code."),
    ),
    PostalCode: z.preprocess(
      trimmed,
      z.string().regex(POSTAL_CODE_PATTERN, "Use a five-digit ZIP code, or ZIP+4."),
    ),
    BedroomsTotal: z.coerce
      .number({ error: "Bedrooms must be a number." })
      .int("Bedrooms must be a whole number.")
      .min(0, "Bedrooms cannot be negative.")
      .max(99),
    BathroomsTotalInteger: z.coerce
      .number({ error: "Bathrooms must be a number." })
      .int("Bathrooms must be a whole number.")
      .min(0, "Bathrooms cannot be negative.")
      .max(99),
    LivingArea: z.preprocess(
      blankToNull,
      z.coerce.number().int("Living area must be a whole number.").positive("Living area must be greater than zero.").nullable(),
    ),
    LotSizeAcres: z.preprocess(
      blankToNull,
      z.coerce.number().min(0, "Lot size cannot be negative.").max(999_999).nullable(),
    ),
    YearBuilt: z.preprocess(
      blankToNull,
      z.coerce
        .number()
        .int("Year built must be a whole number.")
        .min(EARLIEST_YEAR_BUILT, `Year built must be ${EARLIEST_YEAR_BUILT} or later.`)
        .max(new Date().getFullYear() + 2, "Year built is too far in the future.")
        .nullable(),
    ),
    PublicRemarks: optionalText(4000),
    ClosePrice: z.preprocess(
      blankToNull,
      z.coerce.number().positive("Close price must be greater than zero.").max(99_999_999_999).nullable(),
    ),
    CloseDate: z.preprocess(
      blankToNull,
      isoDate("Close date")
        .refine((s) => s <= today(), "Close date cannot be in the future.")
        .nullable(),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.StandardStatus === "Closed") {
      if (v.ClosePrice == null)
        ctx.addIssue({ code: "custom", path: ["ClosePrice"], message: "A closed listing needs a close price." });
      if (v.CloseDate == null)
        ctx.addIssue({ code: "custom", path: ["CloseDate"], message: "A closed listing needs a close date." });
    } else {
      if (v.ClosePrice != null)
        ctx.addIssue({ code: "custom", path: ["ClosePrice"], message: "Close price applies only to closed listings." });
      if (v.CloseDate != null)
        ctx.addIssue({ code: "custom", path: ["CloseDate"], message: "Close date applies only to closed listings." });
    }
    if (v.CloseDate != null && v.CloseDate < v.ListingContractDate)
      ctx.addIssue({ code: "custom", path: ["CloseDate"], message: "Close date cannot be before the listing contract date." });
  });

export type ListingInput = z.infer<typeof listingInputSchema>;
export type FieldErrors = Record<string, string>;

/** Validate raw form values. Returns either clean data or one message per field. */
export function parseListingInput(
  raw: Record<string, unknown>,
): { ok: true; data: ListingInput } | { ok: false; errors: FieldErrors } {
  const result = listingInputSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}
