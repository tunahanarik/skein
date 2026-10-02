import { useEffect, useState } from "react";

/** True when the page should not animate (the user asked for less motion, or no media queries, as in tests). */
function stillPage(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Shows a number counting up from zero once (ease-out, 900 ms), then the exact formatted value.
 * Display only: `final` is what stays on screen, so rounding during the count never sticks.
 */
export function CountUp({ value, format, final }: { value: number | null; format: (n: number) => string; final: string }) {
  const animate = value !== null && Number.isFinite(value) && value !== 0 && !stillPage();
  const [v, setV] = useState<number | null>(animate ? 0 : null);
  useEffect(() => {
    if (!animate || value === null) {
      setV(null);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      if (k >= 1) return setV(null);
      setV(value * (1 - Math.pow(1 - k, 5)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);
  return <>{v === null ? final : format(v)}</>;
}
