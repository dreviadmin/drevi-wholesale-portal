"use client";

import type { Config } from "@/lib/appointments/core";
import { palette } from "@/lib/palette";
import { useToast } from "@/lib/use-toast";
import { FOCUS, Toast } from "./bits";
import { TypesCard } from "./TypesCard";
import { GeneralCard } from "./GeneralCard";
import { HoursCard } from "./HoursCard";
import { ClosuresCard } from "./ClosuresCard";
import { PeopleCard } from "./PeopleCard";
import { WhatsAppCard } from "./WhatsAppCard";

export interface Login { id: string; name: string; email: string; role: string }

const JUMPS: Array<[string, string]> = [
  ["types", "Types"], ["general", "General"], ["hours", "Opening hours"], ["closures", "Closed days"], ["people", "Staff messages"], ["whatsapp", "WhatsApp"],
];

/** Settings: stacked cards, one per area, each saving on its own. */
export function SettingsView({ cfg, logins, today, isOwner }: { cfg: Config; logins: Login[]; today: string; isOwner: boolean }) {
  const [toast, flash] = useToast();
  return (
    <div style={{ maxWidth: 1040 }}>
      <nav aria-label="Settings sections" className="flex overflow-x-auto gap-1.5" style={{ marginBottom: 14, paddingBottom: 2 }}>
        {JUMPS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className={`font-body ${FOCUS}`}
            style={{ fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, color: palette.softBlack, border: "1px solid rgba(26,26,26,0.16)", padding: "0 12px", minHeight: 44, display: "inline-flex", alignItems: "center", whiteSpace: "nowrap", background: "#fff" }}>
            {label}
          </a>
        ))}
      </nav>
      <div className="flex flex-col gap-4">
        <TypesCard types={cfg.types} flash={flash} />
        <GeneralCard settings={cfg.settings} flash={flash} />
        <HoursCard hours={cfg.hours} flash={flash} />
        <ClosuresCard closures={cfg.closures} today={today} flash={flash} />
        <PeopleCard people={cfg.people} logins={logins} digestHour={cfg.settings.digest_hour} flash={flash} />
        <WhatsAppCard settings={cfg.settings} types={cfg.types} today={today} isOwner={isOwner} flash={flash} />
      </div>
      <Toast text={toast} />
    </div>
  );
}
