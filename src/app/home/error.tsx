"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { BuyerFallback } from "@/components/BuyerFallback";

// Anything a buyer page throws lands here instead of Next's bare "Application
// error" screen: a cart action refusing a lapsed or suspended session, a cart
// save that failed, a database blip during render. The other buyer segments
// re-export this file. Try again re-fetches the page before re-rendering it,
// because a server render that failed would otherwise fail again from the
// same payload.
export default function BuyerError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  return (
    <BuyerFallback
      message="Something went wrong on this page. Try again, or go back to your home page. If you have been signed out, log in again."
      onRetry={() =>
        startTransition(() => {
          router.refresh();
          reset();
        })
      }
    />
  );
}
