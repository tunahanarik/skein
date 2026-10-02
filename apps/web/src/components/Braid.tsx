import "../styles/braid.css";

/**
 * The skein: three threads braiding in from the right, light travelling along them. Pure SVG, no
 * image; decorative only. Sized by its container (slice, anchored right).
 */
export function Braid({ className }: { className?: string }) {
  const W = 900;
  const H = 520;
  const strand = (phase: number) => {
    const pts: string[] = [];
    for (let i = 0; i <= 120; i++) {
      const k = i / 120;
      const amp = 18 + 130 * k * k;
      const y = H * 0.5 + amp * Math.sin(k * 5.4 * Math.PI + phase) - (k - 0.5) * 40;
      pts.push(`${i ? "L" : "M"}${(k * W).toFixed(1)} ${y.toFixed(1)}`);
    }
    return pts.join("");
  };
  const strands = [
    { d: strand(0), g: "braid-a", w: 2.6 },
    { d: strand((2 * Math.PI) / 3), g: "braid-b", w: 1.9 },
    { d: strand((4 * Math.PI) / 3), g: "braid-c", w: 1.5 },
  ];
  return (
    <svg className={`braid${className ? ` ${className}` : ""}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="braid-a" x1="0" x2="1">
          <stop offset="0" stopColor="#c8f169" stopOpacity="0" />
          <stop offset="0.55" stopColor="#c8f169" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ecffc2" />
        </linearGradient>
        <linearGradient id="braid-b" x1="0" x2="1">
          <stop offset="0" stopColor="#eafff4" stopOpacity="0" />
          <stop offset="0.6" stopColor="#eafff4" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="braid-c" x1="0" x2="1">
          <stop offset="0" stopColor="#8a9a45" stopOpacity="0" />
          <stop offset="0.6" stopColor="#8a9a45" stopOpacity="0.8" />
          <stop offset="1" stopColor="#b4c76a" />
        </linearGradient>
      </defs>
      <g className="glow">
        {strands.map((s) => (
          <path key={s.g} d={s.d} stroke={`url(#${s.g})`} strokeWidth={s.w * 4} fill="none" />
        ))}
      </g>
      {strands.map((s) => (
        <path key={s.g} d={s.d} stroke={`url(#${s.g})`} strokeWidth={s.w} fill="none" strokeLinecap="round" />
      ))}
      {strands.map((s, i) => (
        <path key={`f-${s.g}`} className={`flow f${i + 1}`} d={s.d} pathLength={1000} stroke="#f6ffe0" strokeWidth={s.w + 0.8} fill="none" strokeLinecap="round" />
      ))}
    </svg>
  );
}
