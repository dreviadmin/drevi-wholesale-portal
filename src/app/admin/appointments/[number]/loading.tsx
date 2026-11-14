import { S } from "../ui";

export default function Loading() {
  return (
    <div className="px-4 md:px-8 py-6" aria-busy="true">
      <p className="font-body" style={S.eyebrow}>Appointments</p>
      <h1 className="font-display" style={S.h1}>Booking</h1>
      <p className="font-body" role="status" style={{ ...S.muted, marginTop: 14 }}>Loading the booking…</p>
    </div>
  );
}
