import { palette } from "@/lib/palette";

// Shown inside the shell while an /admin page loads, so a tap on a tab answers
// at once instead of the old page sitting frozen. The tabs stay put because
// admin/layout.tsx wraps this.
export default function AdminLoading() {
  const card = { background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" } as const;
  return (
    <div className="px-4 md:px-8 py-6 max-w-3xl animate-pulse" role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div style={{ height: 22, width: "45%", background: palette.ivoryDeep }} />
      <div className="mt-5" style={{ ...card, height: 64 }} />
      <div className="mt-2" style={{ ...card, height: 64 }} />
      <div className="mt-2" style={{ ...card, height: 64, width: "80%" }} />
    </div>
  );
}
