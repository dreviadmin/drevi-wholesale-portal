import Link from "next/link";
import { redirect } from "next/navigation";
import { ReceiptText, QrCode, PackageCheck, Tag, ChevronRight, Store, Boxes, Briefcase, Palette } from "lucide-react";
import { getStaff, isAdminRole } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeAttention, computeToday } from "@/lib/attention";
import { spacesForRole } from "@/lib/nav";
import { t } from "@/lib/strings";
import { palette } from "@/lib/palette";
import { formatINR } from "@/lib/format";
import { HomeScanButton } from "./HomeScanButton";

export const dynamic = "force-dynamic";

// Home cockpit (build guide §6.4): greeting + role, sync stamp, today's money,
// the "Needs you" inbox (cost-of-inaction order), quick actions, space tiles.

function greeting(): string {
  const hourIST = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  if (hourIST < 12) return t("home.greeting.morning");
  if (hourIST < 17) return t("home.greeting.afternoon");
  return t("home.greeting.evening");
}

const SEVERITY_COLOR = { high: "#B4423A", medium: palette.goldDeep, low: palette.mutedGreige } as const;

export default async function HomePage() {
  const staff = await getStaff();
  if (!staff) redirect("/login");
  const isAdmin = isAdminRole(staff.role);

  const admin = createAdminClient();
  const [today, attention, { data: syncRow }, { data: todayOrdersCount }] = await Promise.all([
    computeToday(),
    computeAttention(),
    admin.from("wholesale_products").select("synced_at").order("synced_at", { ascending: false }).limit(1).maybeSingle(),
    Promise.resolve({ data: null }),
  ]);
  void todayOrdersCount;

  const syncStamp = syncRow?.synced_at
    ? new Date(syncRow.synced_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })
    : "—";

  const quickActions = [
    { key: "new_bill", label: t("home.action.new_bill"), href: "/admin/in-store", icon: ReceiptText, show: true },
    { key: "new_sku", label: t("home.action.new_sku"), href: "/admin/sku-generator", icon: QrCode, show: true },
    { key: "log_receipt", label: t("home.action.log_receipt"), href: "/admin/receipts/new", icon: PackageCheck, show: isAdmin },
    { key: "price_check", label: t("home.action.price_check"), href: "/admin/retail-check", icon: Tag, show: true },
  ].filter((a) => a.show);

  const spaces = spacesForRole(staff.role).filter((s) => s.key !== "home");

  const metric = (label: string, value: string, accent = false) => (
    <div className="p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
      <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: "0.18em", color: palette.mutedGreige }}>{label}</div>
      <div className="font-display mt-1" style={{ fontSize: 19, fontWeight: 600, color: accent ? palette.goldDeep : palette.black }}>{value}</div>
    </div>
  );

  return (
    <div className="px-4 md:px-8 py-6 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display" style={{ fontSize: 22, fontWeight: 600, color: palette.black }}>
            {greeting()}, {staff.name?.split(" ")[0] ?? staff.email.split("@")[0]}
            <span className="font-body ml-2" style={{ fontSize: 11, letterSpacing: "0.08em", color: palette.mutedGreige, fontWeight: 400 }}>
              · {staff.role.replace("_", " ")}
            </span>
          </h1>
          <div className="font-body mt-1" style={{ fontSize: 11, letterSpacing: "0.06em", color: palette.mutedGreige }}>
            {t("home.synced")} {syncStamp} IST
          </div>
        </div>
      </div>

      {/* Today's money */}
      <div className="mt-5">
        <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>{t("home.today")}</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
          {metric(t("home.sales"), formatINR(today.sales))}
          {metric(t("home.orders"), `${today.orders} · ${today.pieces} ${t("home.pieces")}`)}
          {metric(t("home.advance_in"), formatINR(today.advanceIn))}
          {metric(t("home.balance_due"), formatINR(today.balanceDue), today.balanceDue > 0)}
        </div>
      </div>

      {/* Needs you */}
      <div className="mt-6">
        <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>{t("home.needs_you")}</div>
        <div className="mt-2 flex flex-col gap-1.5">
          {attention.length === 0 && (
            <div className="p-4 font-body" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", fontSize: 12.5, color: palette.softBlack }}>
              {t("home.all_clear")} — {today.orders} order{today.orders === 1 ? "" : "s"} billed today.
            </div>
          )}
          {attention.map((a) => (
            <Link key={a.key} href={a.href} className="flex items-center gap-3 p-3.5" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)" }}>
              <span className="min-w-0 flex-1">
                <span className="font-body block" style={{ fontSize: 13, color: palette.black, fontWeight: 500 }}>{a.title}</span>
                <span className="font-body block mt-0.5" style={{ fontSize: 11, color: palette.mutedGreige }}>{a.sub}</span>
              </span>
              <span
                className="flex-shrink-0 flex items-center justify-center rounded-full font-body"
                style={{ minWidth: 22, height: 22, padding: "0 6px", fontSize: 10.5, fontWeight: 700, background: SEVERITY_COLOR[a.severity], color: palette.ivory }}
              >
                {a.count}
              </span>
              <ChevronRight size={15} color={palette.mutedGreige} />
            </Link>
          ))}
        </div>
      </div>

      {/* Quick actions — gold full-width scan first, per prototype */}
      <div className="mt-6">
        <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>{t("home.quick_actions")}</div>
        <div className="mt-2"><HomeScanButton fullWidth /></div>
        <div className="grid grid-cols-4 gap-2 mt-2">
          {quickActions.map((a) => {
            const Icon = a.icon;
            return (
              <Link key={a.key} href={a.href} className="flex flex-col items-center gap-1.5 py-3.5 font-body uppercase text-center" style={{ background: palette.ivory, border: "1px solid rgba(26,26,26,0.08)", fontSize: 8.5, letterSpacing: "0.1em", color: palette.softBlack }}>
                <Icon size={18} strokeWidth={1.6} color={palette.goldDeep} />
                {a.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Spaces */}
      <div className="mt-6">
        <div className="font-body uppercase" style={{ fontSize: 9.5, letterSpacing: "0.2em", color: palette.softBlack }}>{t("home.spaces")}</div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {spaces.map((s) => {
            const Icon = ({ sell: Store, stock: Boxes, studio: Palette, office: Briefcase } as Record<string, typeof Store>)[s.key] ?? Store;
            const sub = ({ sell: "Billing, price checks", stock: "SKU, receipts, vendors", studio: "Photos, copy, publish", office: "Orders, buyers, reports" } as Record<string, string>)[s.key] ?? "";
            return (
              <Link key={s.key} href={s.items[0].href} className="p-4" style={{ background: palette.black }}>
                <Icon size={17} strokeWidth={1.6} color={palette.gold} />
                <div className="font-body uppercase mt-2" style={{ fontSize: 11, letterSpacing: "0.2em", color: palette.gold, fontWeight: 600 }}>{t(s.label)}</div>
                <div className="font-body mt-1" style={{ fontSize: 10, color: palette.champagne }}>{sub}</div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
