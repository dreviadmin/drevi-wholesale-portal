import { palette } from "@/lib/palette";

export default function ExhibitionStub() {
  return (
    <div className="px-4 md:px-8 py-6">
      <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>Exhibitions</h1>
      <p className="font-body mt-3" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.7, maxWidth: 520 }}>
        Exhibition mode (tablet sessions, on-the-spot capture, PDF delivery) arrives in Phase 4.
      </p>
    </div>
  );
}
