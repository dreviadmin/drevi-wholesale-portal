"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { continueWithLink } from "./actions";
import { palette } from "@/lib/palette";

function OpenButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full font-body uppercase transition-opacity disabled:opacity-60"
      style={{ background: palette.black, color: palette.ivory, fontSize: 11, letterSpacing: "0.2em", padding: "13px 0" }}
    >
      {pending ? "Opening…" : label}
    </button>
  );
}

/**
 * The tap from WhatsApp should land straight in the catalog, so a fresh
 * browser submits this form by itself. It still renders as a real form with
 * a button: without JavaScript, or when the phone is already signed in as
 * someone else (staff testing on their own phone), a person decides.
 */
export function GoForm({
  token,
  business,
  otherSession,
  failed,
}: {
  token: string;
  business: string;
  otherSession: string | null;
  failed: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const fired = useRef(false);
  const auto = !otherSession && !failed;

  useEffect(() => {
    const form = formRef.current;
    if (!auto || fired.current || !form) return;
    fired.current = true;
    // iOS 15 Safari has no requestSubmit; clicking the submit button fires the
    // same submit event the server-action form listens for.
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
  }, [auto]);

  return (
    <form ref={formRef} action={continueWithLink} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      {failed ? (
        <p className="font-body" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.6 }}>
          We couldn&apos;t open your account just now. Please try again in a moment.
        </p>
      ) : otherSession ? (
        <p className="font-body" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.6 }}>
          This phone is signed in as <strong>{otherSession}</strong>. Continue as <strong>{business}</strong> instead?
        </p>
      ) : (
        <p className="font-body" style={{ fontSize: 13, color: palette.softBlack, lineHeight: 1.6 }}>
          Opening the account for <strong>{business}</strong>…
        </p>
      )}
      <OpenButton label={failed ? "Try again" : otherSession ? `Continue as ${business}` : "Open my account"} />
      <Link
        href={otherSession ? "/" : "/login"}
        className="font-body uppercase text-center mt-1"
        style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.mutedGreige }}
      >
        {otherSession ? `Stay as ${otherSession}` : "Log in with password"}
      </Link>
    </form>
  );
}
