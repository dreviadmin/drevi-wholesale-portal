import { palette } from "@/lib/palette";

export default function CatalogLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: palette.ivory }}>
      <div className="font-display animate-pulse" style={{ fontSize: 18, letterSpacing: "0.35em", color: palette.mutedGreige }}>
        DREVI
      </div>
    </div>
  );
}
