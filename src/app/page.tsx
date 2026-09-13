import { redirect } from "next/navigation";
import { resolveActiveRole } from "@/lib/supabase/server";

// The installed PWA launches at "/" (manifest start_url), so this route is what
// answers "am I still signed in?" on every app open. It used to redirect to
// /login unconditionally, which is why a perfectly live session looked expired
// every time the app was reopened. force-dynamic so the role is read from the
// request cookies and Vercel can't serve a prerendered 307 to /login.
export const dynamic = "force-dynamic";

export default async function Home() {
  const role = await resolveActiveRole();
  if (role === "staff") redirect("/admin");
  if (role === "buyer") redirect("/home");
  // No session, or one with no active row (pending/suspended buyer) — /login
  // resolves the role again and forwards on if it can, so this never loops.
  redirect("/login");
}
