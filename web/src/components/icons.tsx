/**
 * A small set of rounded line icons (24×24, 1.8 stroke) and the Hoodmap mark. Inline SVG, so no
 * icon font or third-party request is needed. Decorative by default (aria-hidden).
 */
import type { ReactNode } from "react";

const P: Record<string, ReactNode> = {
  earn: <path d="M4 17l5-5 4 4 7-7M14 9h6v6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  bank: <path d="M4 10l8-5 8 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3.5 20h17" />,
  drop: <path d="M12 3.5c3.5 4.2 6 7.3 6 10.3a6 6 0 0 1-12 0c0-3 2.5-6.1 6-10.3z" />,
  swap: <path d="M7 7h12l-3.5-3.5M17 17H5l3.5 3.5" />,
  bridge: <path d="M3 17c3-6 15-6 18 0M6 13.6V17M12 12v5M18 13.6V17M3 17h18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  star: <path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" />,
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  shield: <path d="M12 3.5l7 3v5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9v-5zM9 12l2.2 2.2L15.5 10" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
  wallet: <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17v3M4 7.5V17a2.5 2.5 0 0 0 2.5 2.5H20V8H6.5A2.5 2.5 0 0 1 4 7.5zM16 13.5h.01" />,
  spark: <path d="M12 4l1.8 4.6L18.5 10l-4.7 1.6L12 16l-1.8-4.4L5.5 10l4.7-1.4zM18.5 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  logout: <path d="M14 7V5.5A1.5 1.5 0 0 0 12.5 4h-6A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20h6a1.5 1.5 0 0 0 1.5-1.5V17M10 12h10M17 9l3 3-3 3" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}

/** The Hoodmap mark: a two-faceted arrowhead. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="mark">
      <path d="M3 21.5 L29 3 L17.5 29 Z" fill="var(--mark-a)" />
      <path d="M29 3 L17.5 29 L14.5 17.5 Z" fill="var(--mark-b)" />
    </svg>
  );
}

/** Soft pastel badge with an icon (intent colour families: earn, fixed, borrow, lp, trade). */
export function Badge({ icon, tone, size = 40 }: { icon: IconName; tone: "earn" | "fixed" | "borrow" | "lp" | "trade"; size?: number }) {
  return (
    <span className={`sbadge t-${tone}`} style={{ width: size, height: size }}>
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </span>
  );
}
