import { redirect } from "next/navigation";
import { resolveActiveRole } from "@/lib/supabase/server";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

// A signed-in user must never be shown a password field — a bookmarked /login,
// a back navigation, or a stale link would otherwise read as a lost session.
// Only a resolved role bounces: an authenticated user with no active row still
// needs the form (the action signs them out and explains why), and bouncing
// them would ping-pong with the pages that redirect here.
export default async function LoginPage() {
  const role = await resolveActiveRole();
  if (role === "staff") redirect("/admin");
  if (role === "buyer") redirect("/home");

  return <LoginForm />;
}
