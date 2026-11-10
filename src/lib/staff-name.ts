// The short name the phone bar shows for the signed-in staff member: the first
// word of their name, else the part of their email before the @.
export function staffFirstName(staff: { name: string | null; email: string }): string {
  return (staff.name ?? "").trim().split(/\s+/)[0] || staff.email.split("@")[0];
}
