import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Lock } from "lucide-react";
import { requireAdminOrRedirect } from "@/lib/staff";
import { loadBoard } from "@/lib/studio/load";
import { AI_ANGLES, DETAIL_ANGLES } from "@/lib/studio/state";
import { palette } from "@/lib/palette";

export const dynamic = "force-dynamic";

// Workbench SKELETON (Stage 3 §7.4): real header + derived badge + gate strip
// with the exact unmet rules; angle/copy cards land in Stages 5–6.
export default async function WorkbenchPage({ params }: { params: { designId: string } }) {
  await requireAdminOrRedirect();
  const rows = await loadBoard();
  const d = rows.find((r) => r.id === params.designId);
  if (!d) notFound();

  return (
    <div className="px-4 md:px-8 py-6 max-w-2xl">
      <Link href="/admin/studio" className="inline-flex items-center gap-1 font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige }}>
        <ChevronLeft size={14} /> Studio
      </Link>

      <div className="mt-4">
        <h1 className="font-mono" style={{ fontSize: 19, fontWeight: 700, color: palette.black }}>
          {d.baseSku} · {d.color}
        </h1>
        <div className="font-body mt-1" style={{ fontSize: 12.5, color: palette.softBlack }}>{d.title ?? "—"}</div>
        <div className="font-body uppercase inline-block mt-2 px-2 py-1" style={{ fontSize: 9, letterSpacing: "0.12em", fontWeight: 600, background: palette.ivoryDeep, color: palette.softBlack }}>
          {d.badgeLabel}
        </div>
      </div>

      {/* Destination strip — the SAME gate functions Stage 7 pushes will call */}
      <div className="grid grid-cols-2 gap-2 mt-5">
        {(["wholesale", "shopify"] as const).map((portal) => {
          const g = d.gates[portal];
          const t = d.targets.find((x) => x.portal === portal);
          const label = portal === "wholesale" ? "Wholesale" : "Shopify";
          return (
            <div key={portal} className="p-3.5" style={{ background: palette.ivory, border: `1px solid ${g.ready ? "#1F6B45" : "rgba(26,26,26,0.1)"}` }}>
              <div className="flex items-center justify-between">
                <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.16em", color: palette.black, fontWeight: 600 }}>{label}</span>
                <span className="font-body" style={{ fontSize: 9.5, color: t?.enabled === false ? palette.mutedGreige : g.ready ? "#1F6B45" : "#8a6d1a" }}>
                  {t?.enabled === false ? "disabled" : t?.state === "live" ? "live" : g.ready ? "ready" : `${g.blockers.length} blocker${g.blockers.length === 1 ? "" : "s"}`}
                </span>
              </div>
              {t?.enabled !== false && !g.ready && (
                <ul className="mt-2">
                  {g.blockers.map((b) => (
                    <li key={b} className="font-body" style={{ fontSize: 10.5, color: palette.mutedGreige, lineHeight: 1.7 }}>· {b}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Angle cards arrive in Stage 5; copy panel in Stage 6 */}
      <div className="mt-5">
        <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Angles</div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {[...AI_ANGLES, ...DETAIL_ANGLES].map((a) => (
            <div key={a} className="flex flex-col items-center justify-center py-8" style={{ background: palette.ivory, border: "1px dashed rgba(26,26,26,0.18)" }}>
              <Lock size={14} color={palette.mutedGreige} />
              <div className="font-body uppercase mt-2" style={{ fontSize: 9, letterSpacing: "0.14em", color: palette.mutedGreige }}>{a.replace("_", " ")}</div>
              <div className="font-body mt-1" style={{ fontSize: 9.5, color: palette.mutedGreige }}>review arrives in Stage 5</div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 p-3.5" style={{ background: palette.ivory, border: "1px dashed rgba(26,26,26,0.18)" }}>
        <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>Copy</div>
        <div className="font-body mt-1" style={{ fontSize: 10.5, color: palette.mutedGreige }}>
          {d.copyStatus === "none" ? "No copy yet — generation arrives in Stage 6." : `Status: ${d.copyStatus}`}
        </div>
      </div>
    </div>
  );
}
