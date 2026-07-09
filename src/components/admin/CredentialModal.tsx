"use client";

import { useState, useTransition } from "react";
import { RefreshCw, Eye, EyeOff, Copy, MessageCircle, X } from "lucide-react";
import { setCredentials } from "@/app/admin/buyers/actions";
import { buildWhatsAppMessage, shareWhatsApp } from "@/lib/share";
import { palette } from "@/lib/palette";

const WORDS = ["Tulip","Lotus","Jasmine","Marigold","Saffron","Indigo","Amber","Coral","Maroon","Ivory","Crimson","Emerald","Champagne","Velvet","Silk","Brocade","Mirror","Pearl","Mango","Peacock","Lantern","Monsoon","Henna","Paisley","Garnet","Topaz","Lilac","Cobalt","Bronze","Copper","Mauve","Sage"];
function memorable(): string {
  const r = (n: number) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  return `${WORDS[r(WORDS.length)]}-${WORDS[r(WORDS.length)]}-${1000 + r(9000)}`;
}

export function CredentialModal({
  buyerId,
  buyer,
  onClose,
}: {
  buyerId: string;
  buyer: { email: string | null; owner_name: string | null; business_name: string | null; phone: string | null };
  onClose: (activated: boolean) => void;
}) {
  const [email, setEmail] = useState(buyer.email ?? "");
  const [mode, setMode] = useState<"auto" | "custom">("auto");
  const [generated, setGenerated] = useState(memorable());
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [openWa, setOpenWa] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState<{ password: string } | null>(null);
  const [isPending, start] = useTransition();

  const password = mode === "auto" ? generated : custom;

  function save() {
    setError(null);
    start(async () => {
      const res = await setCredentials(buyerId, email, password);
      if (!res.ok) { setError(res.error ?? "Failed"); return; }
      setActivated({ password: res.password! });
      if (openWa) {
        await shareWhatsApp(buildWhatsAppMessage(email, res.password!), buyer.phone);
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(26,26,26,0.55)" }}>
      <div className="w-full max-w-md" style={{ background: palette.ivory, padding: 24 }}>
        <div className="flex items-start justify-between">
          <div>
            <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: "0.22em", color: palette.gold }}>Set Credentials</div>
            <div className="font-display mt-1" style={{ fontSize: 16, fontWeight: 600, color: palette.black }}>
              {[buyer.business_name, buyer.owner_name].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button type="button" onClick={() => onClose(!!activated)} aria-label="Close" style={{ color: palette.mutedGreige }}><X size={18} /></button>
        </div>

        {activated ? (
          <div className="mt-5">
            <p className="font-body" style={{ fontSize: 12.5, color: palette.softBlack, lineHeight: 1.6 }}>
              Account activated. Credentials:
            </p>
            <div className="mt-3 p-3 font-body" style={{ background: palette.ivoryDeep, fontSize: 13 }}>
              <div>{email}</div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>{activated.password}</div>
            </div>
            <div className="flex gap-2 mt-4">
              <button type="button" onClick={() => navigator.clipboard?.writeText(`${email}\n${activated.password}`)} className="flex items-center gap-1.5 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.15em", padding: "8px 14px" }}>
                <Copy size={12} /> Copy
              </button>
              <button type="button" onClick={() => shareWhatsApp(buildWhatsAppMessage(email, activated.password), buyer.phone)} className="flex items-center gap-1.5 font-body uppercase" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.15em", padding: "8px 14px" }}>
                <MessageCircle size={12} /> Share via WhatsApp
              </button>
            </div>
            <button type="button" onClick={() => onClose(true)} className="w-full mt-5 font-body uppercase" style={{ background: palette.gold, color: palette.black, fontSize: 11, letterSpacing: "0.2em", padding: "12px 0" }}>Done</button>
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>Username (email)</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} className="font-body bg-transparent outline-none" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)", padding: "7px 2px", fontSize: 13 }} />
            </label>

            <div className="flex flex-col gap-2">
              <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: palette.softBlack }}>Password</span>
              <label className="flex items-center gap-2 font-body" style={{ fontSize: 12 }}>
                <input type="radio" checked={mode === "auto"} onChange={() => setMode("auto")} /> Auto-generate a memorable password
              </label>
              {mode === "auto" && (
                <div className="flex items-center gap-2 ml-5">
                  <span className="font-body" style={{ fontSize: 13, fontWeight: 600, color: palette.black }}>{generated}</span>
                  <button type="button" onClick={() => setGenerated(memorable())} aria-label="Regenerate" style={{ color: palette.goldDeep }}><RefreshCw size={13} /></button>
                </div>
              )}
              <label className="flex items-center gap-2 font-body" style={{ fontSize: 12 }}>
                <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} /> Set a custom password
              </label>
              {mode === "custom" && (
                <div className="flex items-center gap-2 ml-5" style={{ borderBottom: "1px solid rgba(26,26,26,0.25)" }}>
                  <input type={showCustom ? "text" : "password"} value={custom} onChange={(e) => setCustom(e.target.value)} className="font-body bg-transparent outline-none flex-1" style={{ padding: "6px 2px", fontSize: 13 }} />
                  <button type="button" onClick={() => setShowCustom((v) => !v)} style={{ color: palette.mutedGreige }}>{showCustom ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 mt-1">
              <label className="flex items-center gap-2 font-body" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={openWa} onChange={(e) => setOpenWa(e.target.checked)} /> Open WhatsApp share sheet
              </label>
            </div>

            {error && <p className="font-body" style={{ fontSize: 11, color: palette.crimsonText }}>{error}</p>}

            <div className="flex gap-2 mt-2">
              <button type="button" onClick={() => onClose(false)} className="flex-1 font-body uppercase" style={{ border: `1px solid ${palette.black}`, color: palette.black, fontSize: 10, letterSpacing: "0.18em", padding: "11px 0" }}>Cancel</button>
              <button type="button" onClick={save} disabled={isPending || !password} className="flex-1 font-body uppercase disabled:opacity-50" style={{ background: palette.black, color: palette.ivory, fontSize: 10, letterSpacing: "0.18em", padding: "11px 0" }}>
                {isPending ? "Saving…" : "Save & Activate"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
