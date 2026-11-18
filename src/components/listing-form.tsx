"use client";

import Link from "next/link";
import { useActionState } from "react";
import { saveListing, type FormState } from "@/app/actions";

type Props = {
  listingKey: string | null;
  initial: Record<string, string>;
  statusOptions: readonly string[];
  propertyTypes: readonly string[];
  /** MLS staff edits are corrections and must carry a reason. */
  isStaffCorrection: boolean;
  cancelHref: string;
};

export function ListingForm({ listingKey, initial, statusOptions, propertyTypes, isStaffCorrection, cancelHref }: Props) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveListing.bind(null, listingKey), {});
  const value = (name: string) => state.values?.[name] ?? initial[name] ?? "";
  const error = (name: string) =>
    state.errors?.[name] ? (
      <p className="error" id={`${name}-error`}>
        {state.errors[name]}
      </p>
    ) : null;

  const input = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <label className="label">
      {label}
      {props.required && <span className="text-red-700"> *</span>}
      <input
        name={name}
        defaultValue={value(name)}
        aria-invalid={!!state.errors?.[name]}
        aria-describedby={state.errors?.[name] ? `${name}-error` : undefined}
        className="field"
        {...props}
      />
      {hint && <span className="mt-1 block text-xs font-normal text-muted">{hint}</span>}
      {error(name)}
    </label>
  );

  const select = (name: string, label: string, options: readonly string[]) => (
    <label className="label">
      {label}
      <span className="text-red-700"> *</span>
      <select name={name} defaultValue={value(name)} className="field" required>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      {error(name)}
    </label>
  );

  return (
    // The key remounts the form after a failed save so fields show what was typed.
    <form action={action} key={JSON.stringify(state.values ?? {})} className="space-y-6" noValidate>
      {state.message && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {state.message}
        </p>
      )}

      <fieldset className="card grid gap-4 sm:grid-cols-3">
        <legend className="px-1 text-sm font-semibold">Listing</legend>
        {select("StandardStatus", "Status", statusOptions)}
        {select("PropertyType", "Property type", propertyTypes)}
        {input("ListPrice", "List price", { required: true, inputMode: "decimal" })}
        {input("ListingContractDate", "Listing contract date", { required: true, type: "date" })}
        {input("ClosePrice", "Close price", { inputMode: "decimal" }, "Only for closed listings.")}
        {input("CloseDate", "Close date", { type: "date" }, "Only for closed listings.")}
      </fieldset>

      <fieldset className="card grid gap-4 sm:grid-cols-6">
        <legend className="px-1 text-sm font-semibold">Address</legend>
        <div className="sm:col-span-1">{input("StreetNumber", "Street number", { required: true })}</div>
        <div className="sm:col-span-4">{input("StreetName", "Street name", { required: true })}</div>
        <div className="sm:col-span-1">{input("UnitNumber", "Unit")}</div>
        <div className="sm:col-span-3">{input("City", "City", { required: true })}</div>
        <div className="sm:col-span-1">{input("StateOrProvince", "State", { required: true, maxLength: 2 })}</div>
        <div className="sm:col-span-2">{input("PostalCode", "ZIP code", { required: true })}</div>
      </fieldset>

      <fieldset className="card grid gap-4 sm:grid-cols-5">
        <legend className="px-1 text-sm font-semibold">Property</legend>
        {input("BedroomsTotal", "Bedrooms", { required: true, inputMode: "numeric" })}
        {input("BathroomsTotalInteger", "Bathrooms", { required: true, inputMode: "numeric" })}
        {input("LivingArea", "Living area (sq ft)", { inputMode: "numeric" })}
        {input("LotSizeAcres", "Lot size (acres)", { inputMode: "decimal" })}
        {input("YearBuilt", "Year built", { inputMode: "numeric" })}
        <label className="label sm:col-span-5">
          Public remarks
          <textarea name="PublicRemarks" rows={4} defaultValue={value("PublicRemarks")} className="field" />
          {error("PublicRemarks")}
        </label>
      </fieldset>

      {isStaffCorrection && (
        <fieldset className="card border-amber-300 bg-amber-50">
          <legend className="px-1 text-sm font-semibold">Staff correction</legend>
          <label className="label">
            Reason for this correction<span className="text-red-700"> *</span>
            <textarea name="correctionReason" rows={2} defaultValue={value("correctionReason")} className="field" />
            <span className="mt-1 block text-xs font-normal text-muted">
              Recorded permanently in the listing history with your name.
            </span>
            {error("correctionReason")}
          </label>
        </fieldset>
      )}

      <div className="flex gap-3">
        <button className="btn" disabled={pending}>
          {pending ? "Saving…" : listingKey ? "Save changes" : "Create listing"}
        </button>
        <Link href={cancelHref} className="btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  );
}
