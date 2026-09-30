import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { resolveLoginToken } from "@/lib/login-link";
import { loginDisplay } from "@/lib/share";
import { LINK_PAGE_METADATA, LinkRefusal, LinkShell } from "@/components/login-link/LinkShell";
import { GoForm } from "./GoForm";

export const dynamic = "force-dynamic";
export const metadata = LINK_PAGE_METADATA;

export default async function GoPage({ params, searchParams }: { params: { token: string }; searchParams: { e?: string } }) {
  const resolved = await resolveLoginToken(params.token);
  if (!resolved.ok) return <LinkRefusal reason={resolved.reason} />;

  const failed = searchParams.e === "1";
  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const current = user?.email?.toLowerCase() ?? null;

  // Already in as this buyer (the second tap on the same message, or a double
  // submit whose other half won) — straight in, even from the ?e=1 page.
  if (current && current === resolved.buyer.email.toLowerCase()) redirect("/home");

  const business = resolved.buyer.business_name?.trim() || loginDisplay(resolved.buyer.email).value;
  return (
    <LinkShell>
      <GoForm
        token={params.token}
        business={business}
        otherSession={current && current !== resolved.buyer.email.toLowerCase() ? loginDisplay(current).value : null}
        failed={failed}
      />
    </LinkShell>
  );
}
