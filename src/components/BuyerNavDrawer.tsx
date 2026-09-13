"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, Store, ShoppingBag, Wallet, UserRound } from "lucide-react";
import { SignOutButton } from "@/components/SignOutButton";
import { palette } from "@/lib/palette";

// The buyer's one navigation. It used to live inside DreviHeader, and
// DreviHeader is mounted on the catalog alone — so a buyer sitting on /home
// could not reach their orders without going shopping first (Ansh, 13 Sep).
//
// This owns the POSITIONED WRAPPER, not just the panel: the drawer hangs off
// the bar by `absolute left-0 right-0` with no top, so it lands wherever its
// static position falls — directly under the bar — and that only works while
// the bar and the drawer are siblings inside one positioned element. Hosts
// therefore hand over their bar as children and drop their own sticky classes,
// passing the positioning they used to carry as `className`. Each host keeps
// its own bar design and supplies its own menu button.

const ROW = "flex items-center gap-2.5 font-body uppercase px-5 py-3.5";
const ROW_STYLE = {
  fontSize: 11,
  letterSpacing: "0.16em",
  color: palette.black,
  borderBottom: "1px solid rgba(26,26,26,0.06)",
} as const;

// Credit and details sit behind their own doors rather than inside the wallet
// card, so the way in exists even when there is no credit and nothing to fix.
const LINKS = [
  { href: "/catalog", label: "Catalog", Icon: Store },
  { href: "/cart", label: "Cart", Icon: ShoppingBag },
  { href: "/account/orders", label: "My Orders", Icon: ClipboardList },
  { href: "/account/credit", label: "Credit", Icon: Wallet },
  { href: "/account/details", label: "My Details", Icon: UserRound },
] as const;

export function BuyerNavDrawer({
  open,
  onClose,
  cartCount = 0,
  className = "sticky top-0 z-20",
  children,
}: {
  open: boolean;
  onClose: () => void;
  cartCount?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className={className}>
      {/* Above the scrim so the bar — and the button that closes the menu —
          stays legible while the drawer is open. */}
      <div className="relative" style={{ zIndex: 2 }}>
        {children}
      </div>

      {open && (
        <>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="fixed inset-0"
            style={{ background: "rgba(26,26,26,0.28)", zIndex: 0 }}
          />
          <nav
            className="absolute left-0 right-0 flex flex-col"
            style={{
              background: palette.ivory,
              borderBottom: "1px solid rgba(26,26,26,0.12)",
              boxShadow: "0 16px 40px rgba(26,26,26,0.12)",
              zIndex: 1,
            }}
          >
            {LINKS.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                aria-current={pathname === href ? "page" : undefined}
                className={ROW}
                style={{ ...ROW_STYLE, background: pathname === href ? palette.ivoryDeep : undefined }}
              >
                <Icon size={15} strokeWidth={1.7} />
                {label}
                {href === "/cart" && cartCount > 0 ? ` (${cartCount})` : ""}
              </Link>
            ))}
            <SignOutButton
              className="w-full px-5 py-3.5"
              style={{ gap: 10, fontSize: 11, letterSpacing: "0.16em", color: palette.crimsonText }}
              iconSize={15}
            />
          </nav>
        </>
      )}
    </div>
  );
}
