"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { formatINR } from "@/lib/format";
import { palette } from "@/lib/palette";
import { waPhone } from "@/lib/share";
import { variantLabelOf } from "@/lib/variants";
import { normaliseSheetDate } from "@/lib/last-vendor";
import { fmtDay, fmtDayYear } from "@/lib/dashboard/dates";
import { NONE, type Filter } from "@/lib/dashboard/state";
import { customerFacts, categoryKeyOf, type DashContext, type DesignInfo } from "@/lib/dashboard/rollup";
import { partyName, plural, type DashBuyer, type DashOrder } from "@/lib/dashboard/lines";
import { CallLink, CopyCode, FilterLink, Thumb, creditCell } from "./views";
import type { Nav } from "./useDashState";
import type { VendorProfile } from "./load";

const BOX: React.CSSProperties = { background: palette.ivoryDeep, padding: "10px 12px" };
const NAME: React.CSSProperties = { fontSize: 16, fontWeight: 600, color: palette.black };
const FACT: React.CSSProperties = { fontSize: 11.5, color: palette.softBlack };
const LINK: React.CSSProperties = { fontSize: 9.5, letterSpacing: "0.12em", padding: "8px 0", margin: "-4px 0", color: palette.goldDeep, textDecoration: "underline" };

export function Contact({ name, phone, whatsapp }: { name: string; phone: string | null; whatsapp?: string | null }) {
  const wa = waPhone(whatsapp ?? phone);
  return (
    <span className="flex items-center gap-1.5 flex-none">
      <CallLink phone={phone} name={name} />
      {wa && (
        <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${name}`} className="inline-flex items-center justify-center" style={{ width: 28, height: 28, border: `1px solid ${palette.gold}`, borderRadius: 999 }}>
          <MessageCircle size={13} strokeWidth={1.8} color={palette.goldDeep} />
        </a>
      )}
    </span>
  );
}

function VendorHeader({ nav, vendor, profile }: { nav: Nav; vendor: { key: string; name: string }; profile: VendorProfile | null }) {
  const known = vendor.name !== "Vendor not found";
  return (
    <div className="flex items-center justify-between gap-3" style={BOX}>
      <div className="min-w-0">
        <h2 className="font-display truncate" style={NAME}>{vendor.name}</h2>
        <div className="font-body" style={FACT}>
          {[profile?.city, profile?.phone].filter(Boolean).join(" · ") || (vendor.key === NONE ? "These products have no vendor on file." : known ? "No contact on file." : "This link no longer matches a vendor.")}
        </div>
        {profile && (
          <Link href={nav.onward(`/admin/vendors/${vendor.key}`)} prefetch={false} className="font-body uppercase inline-block" style={LINK}>Vendor page</Link>
        )}
      </div>
      <Contact name={vendor.name} phone={profile?.phone ?? null} whatsapp={profile?.whatsapp} />
    </div>
  );
}

function CustomerHeader({ nav, id, buyer, orders, credit, phone }: { nav: Nav; id: string; buyer: DashBuyer | null; orders: DashOrder[]; credit: number; phone: string | null }) {
  const facts = customerFacts(orders, id);
  const name = partyName(buyer);
  if (!buyer) {
    return (
      <div style={BOX}>
        <h2 className="font-display truncate" style={NAME}>Customer not found</h2>
        <div className="font-body" style={FACT}>This link no longer matches a customer.</div>
      </div>
    );
  }
  return (
    <div style={BOX}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display truncate" style={NAME}>{name}</h2>
          <div className="font-body truncate" style={FACT}>{[buyer?.owner_name, buyer?.city, phone].filter(Boolean).join(" · ")}</div>
        </div>
        <Contact name={name} phone={phone} />
      </div>
      <div className="font-display mt-1.5" style={{ fontSize: 15, fontWeight: 600, color: facts.owes > 0 ? palette.crimsonText : palette.black }}>
        {facts.owes > 0 ? `Owes ${formatINR(facts.owes)} on ${facts.owingOrders} order${facts.owingOrders === 1 ? "" : "s"}` : "Nothing owed"}
      </div>
      <div className="font-body" style={{ ...FACT, color: palette.mutedGreige }}>
        All their orders, whatever the dates say.
        {facts.unsupplied > 0 && ` Includes about ${formatINR(facts.unsupplied)} not supplied yet.`}
      </div>
      {(credit !== 0 || facts.overpaid > 0 || facts.heldOnCancelled > 0) && (
        <div className="font-body mt-0.5 flex gap-x-3 flex-wrap" style={FACT}>
          {credit !== 0 && <span>Wallet credit {creditCell(credit)}</span>}
          {facts.overpaid > 0 && <span>Overpaid {formatINR(facts.overpaid)}</span>}
          {facts.heldOnCancelled > 0 && <span>{formatINR(facts.heldOnCancelled)} paid on cancelled orders</span>}
        </div>
      )}
      <Link href={nav.onward(`/admin/buyers/${id}`)} prefetch={false} className="font-body uppercase inline-block" style={LINK}>Customer page</Link>
    </div>
  );
}

function SupplyFacts({ design }: { design: DesignInfo }) {
  const s = design.supply;
  if (!s) return null;
  const modes: Record<string, string> = { ready_stock: "Ready stock", made_to_order: "Made to order", both: "Ready stock or made to order", discontinued: "Discontinued" };
  const facts = [
    s.supply_mode ? modes[s.supply_mode] ?? s.supply_mode : null,
    s.vendor_stock_qty != null ? `Vendor holds ${s.vendor_stock_qty}` : null,
    s.making_days != null ? `Makes in ${plural(s.making_days, "day")}` : null,
    s.making_moq != null ? `Minimum ${s.making_moq}` : null,
    s.delivery_days != null ? `Delivers in ${plural(s.delivery_days, "day")}` : null,
  ].filter(Boolean);
  if (!facts.length && !s.supply_note) return null;
  return <div className="font-body" style={FACT}>{facts.join(" · ")}{s.supply_note ? ` · ${s.supply_note}` : ""}</div>;
}

function DesignHeader({ nav, design, ctx, title, image, profileByKey, startOpen }: {
  nav: Nav; design: DesignInfo | null; ctx: DashContext; title: string; image: string | null;
  profileByKey: (key: string) => VendorProfile | null; startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const vendor = design?.vendor ?? null;
  const profile = vendor ? profileByKey(vendor.key) : null;
  const prices = (design?.variants ?? []).map((p) => p.wholesale_price).filter((p) => p > 0);
  const low = prices.length ? Math.min(...prices) : 0;
  const high = prices.length ? Math.max(...prices) : 0;
  const lead = design?.variants[0];
  const leadKey = lead?.sku.trim().toUpperCase() ?? "";
  const info = ctx.infoBySku.get(leadKey) ?? null;
  const gr = (design?.variants ?? []).map((p) => ctx.grBySku[p.sku.trim().toUpperCase()]).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date))[0];
  const costDate = normaliseSheetDate(info?.last_receipt_date);
  const vendorCode = (design?.variants ?? []).map((p) => ctx.vendorBySku[p.sku.trim().toUpperCase()]?.vendorSku).find(Boolean);

  return (
    <div style={BOX}>
      <div className="flex items-start gap-3">
        <Thumb src={image} alt={title} width={44} height={55} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display line-clamp-2" style={NAME}>{title}</h2>
          <div className="font-body truncate" style={{ fontSize: 10, color: palette.mutedGreige, letterSpacing: "0.04em" }}>{design?.label ?? "Custom piece, not in the catalog"}</div>
          {design && (
            <div className="font-body flex items-center gap-x-3 gap-y-0.5 flex-wrap mt-0.5" style={FACT}>
              {vendor && <span>Vendor <FilterLink nav={nav} filter={{ dim: "vendor", value: vendor.key }} fresh label={`Open vendor ${vendor.name}`} className="font-body" style={{ borderBottom: `1px solid ${palette.gold}` }}>{vendor.name}</FilterLink></span>}
              {design.categoryLabel && <FilterLink nav={nav} filter={{ dim: "category", value: categoryKeyOf(design.categoryLabel) }} fresh label={`Open category ${design.categoryLabel}`} className="font-body" style={{ borderBottom: `1px solid ${palette.gold}` }}>{design.categoryLabel}</FilterLink>}
              {low > 0 && <span>Wholesale {low === high ? formatINR(low) : `${formatINR(low)} to ${formatINR(high)}`}</span>}
            </div>
          )}
        </div>
        {vendor && <Contact name={vendor.name} phone={profile?.phone ?? null} whatsapp={profile?.whatsapp} />}
      </div>
      {design && (
        <>
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-block md:hidden font-body uppercase mt-1.5" style={LINK}>{open ? "Hide details" : "Details"}</button>
          <div className={open ? "block mt-1.5" : "hidden md:block mt-1.5"}>
            <div className="font-body flex gap-x-3 flex-wrap" style={FACT}>
              <span style={{ color: palette.mutedGreige }}>In stock</span>
              {design.variants.filter((p) => p.wholesale_visible).map((p) => (
                <span key={p.sku} style={{ color: p.current_qty <= 0 ? palette.crimsonText : undefined }}>{variantLabelOf(p.sku).split(" · ")[0]} {p.current_qty}</span>
              ))}
            </div>
            <div className="font-body flex gap-x-3 flex-wrap items-center" style={FACT}>
              {gr && <span>{gr.cost > 0 ? `Last bought ${formatINR(gr.cost)} on ${fmtDayYear(gr.date)}` : `Last bought on ${fmtDayYear(gr.date)}, no cost entered`}</span>}
              {info && info.last_cost > 0 && <span>Cost basis {formatINR(info.last_cost)}{costDate ? ` (${fmtDay(costDate)})` : ""}</span>}
              {vendorCode && <span>Vendor SKU <CopyCode code={vendorCode} /></span>}
              {lead && <span>{lead.restockable ? "Restockable" : "Not restockable"}</span>}
            </div>
            <SupplyFacts design={design} />
          </div>
        </>
      )}
    </div>
  );
}

/** Who the page is narrowed to: always the last thing tapped, however deep the filters go. */
export function EntityHeader({ nav, filter, label, ctx, orders, buyerById, creditByBuyer, buyerPhone, profileByKey, image, startOpen }: {
  nav: Nav;
  filter: Filter;
  label: string;
  ctx: DashContext;
  orders: DashOrder[];
  buyerById: Map<string, DashBuyer>;
  creditByBuyer: Record<string, number>;
  buyerPhone: (id: string) => string | null;
  profileByKey: (key: string) => VendorProfile | null;
  image: string | null;
  startOpen: boolean;
}) {
  if (filter.dim === "vendor") return <VendorHeader nav={nav} vendor={{ key: filter.value, name: label }} profile={profileByKey(filter.value)} />;
  if (filter.dim === "customer") {
    return <CustomerHeader key={filter.value} nav={nav} id={filter.value} buyer={buyerById.get(filter.value) ?? null} orders={orders} credit={Number(creditByBuyer[filter.value]) || 0} phone={buyerPhone(filter.value)} />;
  }
  if (filter.dim === "design") {
    return <DesignHeader key={filter.value} nav={nav} design={ctx.designs.get(filter.value) ?? null} ctx={ctx} title={label} image={image} profileByKey={profileByKey} startOpen={startOpen} />;
  }
  return (
    <div style={BOX}>
      <h2 className="font-display truncate" style={NAME}>{label}</h2>
      <div className="font-body" style={FACT}>{filter.dim === "event" ? "Exhibition" : "Category"}</div>
    </div>
  );
}
