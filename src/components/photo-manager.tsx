"use client";

import { useActionState, useState } from "react";
import { deletePhoto, uploadPhoto, type FormState } from "@/app/actions";

function RemoveButton({ mediaKey, order, reason }: { mediaKey: string; order: number; reason: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(deletePhoto.bind(null, mediaKey), {});
  return (
    <form action={action}>
      {reason !== null && <input type="hidden" name="correctionReason" value={reason} />}
      <button className="btn-secondary mt-2 w-full !py-1" disabled={pending} aria-label={`Remove photo ${order}`}>
        Remove
      </button>
      {state.errors?.correctionReason && <p className="error">{state.errors.correctionReason}</p>}
      {state.message && !state.errors?.correctionReason && state.message !== "Photo removed." && (
        <p className="error">{state.message}</p>
      )}
    </form>
  );
}


export function PhotoManager({
  listingKey,
  photos,
  isStaffCorrection,
}: {
  listingKey: string;
  photos: { MediaKey: string; Order: number }[];
  isStaffCorrection: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(uploadPhoto.bind(null, listingKey), {});
  const [reason, setReason] = useState("");
  const failed = state.message && state.message !== "Photo added.";
  return (
    <section className="card">
      <h2 className="text-base font-semibold">Photos</h2>
      {isStaffCorrection && (
        <label className="label mt-3">
          Reason for photo correction<span className="text-red-700"> *</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="field" />
          <span className="mt-1 block text-xs font-normal text-muted">Needed before staff add or remove a photo.</span>
        </label>
      )}
      {photos.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No photos yet.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {photos.map((p) => (
            <li key={p.MediaKey}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/media/${p.MediaKey}`} alt={`Photo ${p.Order}`} className="aspect-[4/3] w-full rounded-md object-cover" />
              <RemoveButton mediaKey={p.MediaKey} order={p.Order} reason={isStaffCorrection ? reason : null} />
            </li>
          ))}
        </ul>
      )}
      <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
        {isStaffCorrection && <input type="hidden" name="correctionReason" value={reason} />}
        <label className="label">
          Add a photo
          <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required className="field" />
        </label>
        <button className="btn" disabled={pending}>
          {pending ? "Uploading…" : "Upload"}
        </button>
      </form>
      <p className="mt-1 text-xs text-muted">JPEG, PNG, or WebP, up to 8 MB.</p>
      {failed && (
        <p role="alert" className="error">
          {state.errors?.correctionReason ?? state.message}
        </p>
      )}
    </section>
  );
}
