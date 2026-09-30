import { headers } from "next/headers";
import { createServerSupabase } from "@/lib/supabase/server";
import { loginDetailsForToken, requestOrigin } from "@/lib/login-link";
import { loginDisplay } from "@/lib/share";
import { writeAuditEvent } from "@/lib/audit";
import { LINK_PAGE_METADATA, LinkRefusal, LinkShell } from "@/components/login-link/LinkShell";
import { LoginCard } from "./LoginCard";

export const dynamic = "force-dynamic";
export const metadata = LINK_PAGE_METADATA;

// /id/<token> — the button under Rakesh's greeting video ("your login is
// below"). Shows the buyer their username and password, and offers the same
// one-tap sign-in as /go/<token>. Same token, same refusals.
export default async function LoginDetailsPage({ params }: { params: { token: string } }) {
  const details = await loginDetailsForToken(params.token);
  if (!details.ok) return <LinkRefusal reason={details.reason} />;

  const supabase = createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const signedIn = !!user?.email && user.email.toLowerCase() === details.buyer.email.toLowerCase();

  // Showing a password is a credential view; the buyer is the viewer.
  const h = headers();
  await writeAuditEvent({
    eventType: "credential_viewed",
    buyerId: details.buyer.id,
    ipAddress: (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim() || null,
    userAgent: h.get("user-agent"),
    notes: "buyer opened their login details from the WhatsApp button",
  });

  const username = loginDisplay(details.buyer.email);
  return (
    <LinkShell>
      <LoginCard
        token={params.token}
        business={details.buyer.business_name?.trim() || username.value}
        site={new URL(requestOrigin()).host}
        username={username}
        password={details.password}
        signedIn={signedIn}
      />
    </LinkShell>
  );
}
