import { logout } from "@/app/actions";
import { palette } from "@/lib/palette";

// Placeholder — the full admin (Buyers, Orders, Audit Log) arrives in Phase 3.
// Middleware already gates this route to active staff.
export default function AdminPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6" style={{ background: palette.pageBg }}>
      <div className="text-center max-w-md">
        <div className="font-display" style={{ fontSize: 26, letterSpacing: "0.3em", color: palette.black, fontWeight: 600 }}>
          DREVI · ADMIN
        </div>
        <p className="font-body mt-4" style={{ fontSize: 12, letterSpacing: "0.04em", color: palette.softBlack, lineHeight: 1.7 }}>
          The admin workspace — Buyers, Orders, and the Audit Log — arrives in Phase 3.
        </p>
        <form action={logout} className="mt-8">
          <button
            type="submit"
            className="font-body uppercase"
            style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.2em", padding: "9px 20px" }}
          >
            Sign Out
          </button>
        </form>
      </div>
    </main>
  );
}
