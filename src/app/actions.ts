"use server";

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";

export async function logout() {
  const supabase = createServerSupabase();
  // Only this device. signOut() defaults to 'global', which would also log out
  // the buyer's phone and installed app, and every device on a shared shop
  // login — the /id page tells buyers to use one login on any phone or laptop.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
