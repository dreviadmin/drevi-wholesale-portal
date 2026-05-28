"use client";

import { palette } from "@/lib/palette";

// Horizontal-scroll category chips, ported from the prototype.
export function FilterChips({
  categories,
  active,
  onSelect,
}: {
  categories: string[];
  active: string;
  onSelect: (category: string) => void;
}) {
  return (
    <div
      className="px-4 py-3 overflow-x-auto no-scrollbar"
      style={{ background: palette.ivory, borderBottom: "1px solid rgba(26,26,26,0.05)" }}
    >
      <div className="flex gap-2" style={{ width: "max-content" }}>
        {categories.map((cat) => {
          const isActive = cat === active;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => onSelect(cat)}
              className="font-body uppercase whitespace-nowrap"
              style={{
                color: isActive ? palette.ivory : palette.softBlack,
                background: isActive ? palette.black : "transparent",
                border: isActive ? "none" : "1px solid rgba(26,26,26,0.18)",
                padding: "7px 14px",
                fontSize: 10,
                letterSpacing: "0.18em",
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>
    </div>
  );
}
