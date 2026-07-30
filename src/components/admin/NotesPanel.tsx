"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, StickyNote, Trash2, X } from "lucide-react";
import { addEntityNote, deleteEntityNote } from "@/app/admin/notes-actions";
import { ZoomImage } from "@/components/Lightbox";
import { palette } from "@/lib/palette";
import type { EntityNote, NoteEntityType } from "@/lib/entity-notes";

// Notes panel (Ansh, 30 Jul) — every entity page mounts this: a running log of
// "details we might forget", each note with optional photos. Add is staff;
// delete is admin (the button just errors politely for staff).

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function NotesPanel({
  entityType,
  entityId,
  notes,
  revalidate,
}: {
  entityType: NoteEntityType;
  entityId: string;
  notes: EntityNote[];
  /** Path to revalidate after a change — the page this panel sits on. */
  revalidate: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement | null>(null);

  function save() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("note", text);
      for (const p of photos) fd.append("photos", p);
      const res = await addEntityNote(entityType, entityId, revalidate, fd);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setText("");
      setPhotos([]);
      router.refresh();
    });
  }

  function remove(id: string) {
    if (!window.confirm("Remove this note?")) return;
    startTransition(async () => {
      const res = await deleteEntityNote(id, revalidate);
      if (!res.ok) setError(res.error ?? "Failed");
      router.refresh();
    });
  }

  return (
    <div className="mt-6">
      <div className="flex items-center gap-1.5">
        <StickyNote size={13} color={palette.goldDeep} />
        <span className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>
          Notes{notes.length > 0 ? ` · ${notes.length}` : ""}
        </span>
      </div>

      {/* Composer */}
      <div className="mt-2 p-2.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.1)" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Anything worth remembering — payment quirks, quality issues, promises made…"
          className="w-full font-body bg-transparent outline-none"
          style={{ fontSize: 12.5, lineHeight: 1.6, color: palette.black }}
        />
        {photos.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mt-1">
            {photos.map((p, i) => (
              <span key={`${p.name}-${i}`} className="flex items-center gap-1 font-body" style={{ fontSize: 9.5, background: palette.ivoryDeep, padding: "3px 7px", color: palette.softBlack }}>
                {p.name.length > 22 ? `${p.name.slice(0, 20)}…` : p.name}
                <button type="button" onClick={() => setPhotos((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${p.name}`}>
                  <X size={11} color={palette.mutedGreige} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 mt-1.5">
          <button
            type="button"
            disabled={pending || photos.length >= 4}
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-1 font-body uppercase disabled:opacity-40"
            style={{ fontSize: 8.5, letterSpacing: "0.12em", border: "1px solid rgba(26,26,26,0.25)", color: palette.black, padding: "6px 10px" }}
          >
            <Camera size={11} /> Photo
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              setPhotos((cur) => [...cur, ...picked].slice(0, 4));
              e.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            disabled={pending || (!text.trim() && photos.length === 0)}
            onClick={save}
            className="ml-auto font-body uppercase disabled:opacity-40"
            style={{ fontSize: 9, letterSpacing: "0.14em", background: palette.black, color: palette.ivory, padding: "8px 14px" }}
          >
            {pending ? "Saving…" : "Add note"}
          </button>
        </div>
        {error && <p className="font-body mt-1.5" style={{ fontSize: 10.5, color: palette.crimsonText }}>{error}</p>}
      </div>

      {/* Log — newest first */}
      {notes.map((n) => (
        <div key={n.id} className="mt-2 p-2.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
          <div className="flex items-baseline gap-2">
            <span className="font-body" style={{ fontSize: 9.5, color: palette.mutedGreige }}>
              {fmtWhen(n.createdAt)}{n.createdBy ? ` · ${n.createdBy.split("@")[0]}` : ""}
            </span>
            <button type="button" onClick={() => remove(n.id)} aria-label="Remove note" className="ml-auto" style={{ color: palette.mutedGreige }}>
              <Trash2 size={12} />
            </button>
          </div>
          {n.note && (
            <p className="font-body mt-1" style={{ fontSize: 12.5, lineHeight: 1.6, color: palette.softBlack, whiteSpace: "pre-wrap" }}>{n.note}</p>
          )}
          {n.photoRefs.length > 0 && (
            <div className="flex gap-2 flex-wrap mt-1.5">
              {n.photoRefs.map((ref) => (
                <ZoomImage key={ref} src={`/api/drive-photo?id=${encodeURIComponent(ref)}&s=300`} alt="Note photo" width={72} height={90} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
