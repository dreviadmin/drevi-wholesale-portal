"use client";

import { LogOut } from "lucide-react";
import { logout } from "@/app/actions";
import { palette } from "@/lib/palette";

// The one way out of the app (14 Sep). Every bar used to paste its own
// <form action={logout}> and most of them dropped the words, so half the buyer
// surfaces offered a bare icon and two offered nothing at all — the owner
// could not find the option. One component, one label, no drift.
//
// "use client" because BuyerNavDrawer is a client component and cannot import
// a server one. `logout` stays a server action across the boundary, so this
// still posts a real form and works with JS off.

const BASE_CLASS = "inline-flex items-center gap-1 font-body uppercase whitespace-nowrap";
const BASE_STYLE = { fontSize: 10, letterSpacing: "0.15em", color: palette.mutedGreige } as const;

export function SignOutButton({
  className,
  style,
  iconSize = 14,
}: {
  className?: string;
  style?: React.CSSProperties;
  iconSize?: number;
}) {
  return (
    <form action={logout}>
      <button
        type="submit"
        // Inline style wins over the base classes, so a host restyling the row
        // (the drawer wants a wider gap) never has to fight Tailwind's order.
        className={className ? `${BASE_CLASS} ${className}` : BASE_CLASS}
        style={{ ...BASE_STYLE, ...style }}
      >
        <LogOut size={iconSize} strokeWidth={1.7} /> Log out
      </button>
    </form>
  );
}
