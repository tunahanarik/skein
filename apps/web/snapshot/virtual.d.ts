declare module "virtual:skein-site" {
  const data: {
    capturedAt: string;
    block: string | null;
    /** Symbols with full asset detail in the snapshot. */
    detailed: string[];
    /** A pool contract with a captured portfolio, offered as the address to try. */
    sampleWallet: string | null;
    /** Captured responses by request key (keys.ts). */
    get: Record<string, unknown>;
    logos: Record<string, string>;
    stream: { pairs: unknown[]; prices: unknown[]; pollMs: number };
  };
  export default data;
}
