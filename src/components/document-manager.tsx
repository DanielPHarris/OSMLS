"use client";

import { useActionState, useState } from "react";
import {
  deleteDocument,
  replaceDocumentFile,
  saveDocumentDetails,
  uploadDocument,
  type FormState,
} from "@/app/actions";

export type ManagedDocument = {
  MediaKey: string;
  name: string;
  permission: string;
  type: string;
  size: string;
};

type Shared = { permissions: { value: string; label: string }[]; reason: string | null };

const NO_CODES =
  "Do not upload anything containing lockbox combinations or gate codes. OSMLS does not check files for them.";

function Feedback({ state, okMessages }: { state: FormState; okMessages: string[] }) {
  if (!state.message) return null;
  const ok = okMessages.includes(state.message);
  const detail = Object.values(state.errors ?? {})[0];
  return (
    <p role={ok ? "status" : "alert"} className={ok ? "mt-1 text-sm text-green-800" : "error"}>
      {ok ? state.message : (detail ?? state.message)}
    </p>
  );
}

const Reason = ({ reason }: { reason: string | null }) =>
  reason === null ? null : <input type="hidden" name="correctionReason" value={reason} />;

function PermissionSelect({ shared, defaultValue }: { shared: Shared; defaultValue: string }) {
  return (
    <label className="label">
      Who can see it
      <select name="permission" defaultValue={defaultValue} className="field">
        {shared.permissions.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DocumentRow({ doc, shared }: { doc: ManagedDocument; shared: Shared }) {
  const [details, saveDetails, saving] = useActionState<FormState, FormData>(saveDocumentDetails.bind(null, doc.MediaKey), {});
  const [replaced, replace, replacing] = useActionState<FormState, FormData>(replaceDocumentFile.bind(null, doc.MediaKey), {});
  const [removed, remove, removing] = useActionState<FormState, FormData>(deleteDocument.bind(null, doc.MediaKey), {});
  return (
    <li>
      <fieldset className="rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{doc.name}</legend>
        <p className="text-sm text-muted">
          {doc.type}, {doc.size} ·{" "}
          <a href={`/documents/${doc.MediaKey}`} className="text-brand underline">
            Download
          </a>
        </p>
        <form action={saveDetails} key={`${doc.name}|${doc.permission}`} className="mt-2 flex flex-wrap items-end gap-3">
          <Reason reason={shared.reason} />
          <label className="label">
            Name
            <input name="name" defaultValue={doc.name} required maxLength={120} className="field" />
          </label>
          <PermissionSelect shared={shared} defaultValue={doc.permission} />
          <button className="btn-secondary" disabled={saving}>
            Save details
          </button>
        </form>
        <Feedback state={details} okMessages={["Document updated.", "Nothing was changed."]} />
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <form action={replace} className="flex flex-wrap items-end gap-3">
            <Reason reason={shared.reason} />
            <label className="label">
              Replace the file
              <input name="file" type="file" accept="application/pdf,image/jpeg,image/png" required className="field" />
            </label>
            <button className="btn-secondary" disabled={replacing}>
              Replace
            </button>
          </form>
          <form action={remove}>
            <Reason reason={shared.reason} />
            <button className="btn-secondary" disabled={removing} aria-label={`Delete ${doc.name}`}>
              Delete
            </button>
          </form>
        </div>
        <Feedback state={replaced} okMessages={["File replaced."]} />
        <Feedback state={removed} okMessages={["Document deleted."]} />
      </fieldset>
    </li>
  );
}

export function DocumentManager({
  listingKey,
  documents,
  permissions,
  defaultPermission,
  isStaffCorrection,
}: {
  listingKey: string;
  documents: ManagedDocument[];
  permissions: { value: string; label: string }[];
  defaultPermission: string;
  isStaffCorrection: boolean;
}) {
  const [state, upload, uploading] = useActionState<FormState, FormData>(uploadDocument.bind(null, listingKey), {});
  const [reason, setReason] = useState("");
  const shared: Shared = { permissions, reason: isStaffCorrection ? reason : null };
  return (
    <section className="card" aria-labelledby="documents-heading">
      <h2 id="documents-heading" className="text-base font-semibold">
        Documents
      </h2>
      <p className="mt-1 text-sm text-muted">
        PDF, JPEG, or PNG, up to 15 MB each. Replacing or deleting a document destroys the old file; history keeps
        a record of it.
      </p>
      <p className="mt-1 text-sm font-medium text-amber-900">{NO_CODES}</p>
      {isStaffCorrection && (
        <label className="label mt-3">
          Reason for document correction<span className="text-red-700"> *</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="field" />
          <span className="mt-1 block text-xs font-normal text-muted">
            Needed before staff add, change, or delete a document.
          </span>
        </label>
      )}
      {documents.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No documents yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {documents.map((doc) => (
            <DocumentRow key={doc.MediaKey} doc={doc} shared={shared} />
          ))}
        </ul>
      )}
      <form action={upload} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <Reason reason={shared.reason} />
        <label className="label">
          New document name
          <input name="name" required maxLength={120} defaultValue={state.values?.name} className="field" />
        </label>
        <PermissionSelect shared={shared} defaultValue={state.values?.permission ?? defaultPermission} />
        <label className="label">
          File
          <input name="file" type="file" accept="application/pdf,image/jpeg,image/png" required className="field" />
        </label>
        <button className="btn" disabled={uploading}>
          {uploading ? "Uploading…" : "Add document"}
        </button>
      </form>
      <Feedback state={state} okMessages={["Document added."]} />
    </section>
  );
}
