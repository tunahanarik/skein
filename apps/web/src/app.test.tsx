// @vitest-environment jsdom
/**
 * Web UI over the offline fixture world: the real AssetIntelligenceService answers a fetch stub,
 * so the app renders the same JSON shape the server sends.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toJson } from "@skein/server/json";
import { intelligenceStack } from "@skein/testkit/intelligence";
import { WALLET } from "@skein/testkit/world";
import { App } from "./App";

async function mountAt(path: string) {
  const st = await intelligenceStack();
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://localhost");
    calls.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) => new Response(toJson(body), { status, headers: { "content-type": "application/json" } });
    const p = url.pathname;
    if (p === "/api/assets") return json({ assets: st.s.registry.canonical().filter((a) => a.address).map((a) => ({ key: a.key, symbol: a.symbol, name: a.name, type: a.type, address: a.address, decimals: a.decimals })) });
    if (p === "/api/coverage") return json({ rows: await st.service.getCoverage() });
    const m = /^\/api\/assets\/(.+)$/.exec(p);
    if (m) {
      const sym = decodeURIComponent(m[1]!);
      const key = /^0x/.test(sym) ? sym : st.s.registry.canonicalBySymbol(sym)[0]?.key;
      if (!key) return json({ error: { code: "UNKNOWN_ASSET", message: "x" } }, 404);
      const to = url.searchParams.get("to");
      const amount = url.searchParams.get("amount");
      const toKey = to ? st.s.registry.canonicalBySymbol(to)[0]?.key : undefined;
      return json(await st.service.getAssetIntelligence(key, { ...(url.searchParams.get("mode") ? { mode: "DEBUG" as const } : {}), ...(toKey ? { tradeTarget: toKey } : {}), ...(amount ? { tradeAmount: amount } : {}) }));
    }
    const w = /^\/api\/portfolio\/(.+)$/.exec(p);
    if (w) return json(await st.service.getPortfolioIntelligence(decodeURIComponent(w[1]!)));
    return json({ error: { code: "NOT_FOUND", message: "x" } }, 404);
  });
  history.pushState(null, "", path);
  render(<App />);
  return { calls, st };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-skein-theme");
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("asset page", () => {
  it("renders the intents for NVDA with neutral action labels", async () => {
    await mountAt("/asset/NVDA");
    expect(await screen.findByRole("heading", { name: "NVDA", level: 1 })).toBeTruthy();
    expect(await screen.findByText(/Buy PT-NVDA-15OCT2026 with NVDA/)).toBeTruthy();
    expect(screen.getByText("Borrow USDG against NVDA")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bbest\b|safest/i);
  });

  it("the trade target picker lists only assets with a verified route", async () => {
    const { st } = await mountAt("/asset/NVDA");
    const nvda = await st.service.getAssetIntelligence(st.s.registry.canonicalBySymbol("NVDA")[0]!.key);
    const select = (await screen.findByLabelText("Into")) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value).sort();
    expect(options).toEqual([...new Set(nvda.tradeTargets.map((x) => x.symbol))].sort());
    expect(options).not.toContain("SPLT"); // no route from NVDA
    expect(options[0]).toBeDefined();
  });

  it("route rows expand from the keyboard", async () => {
    await mountAt("/asset/NVDA");
    const table = (await screen.findAllByRole("table"))[0]!;
    const row = within(table).getAllByRole("row")[1]!;
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("estimate and links", () => {
  it("estimates PT earnings to maturity and validates input", async () => {
    await mountAt("/asset/NVDA");
    const summary = (await screen.findAllByText("Estimate earnings"))[0]!;
    fireEvent.click(summary);
    const input = within(summary.closest("details")!).getByLabelText(/Amount of NVDA/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "100" } });
    expect(await screen.findByText(/at maturity/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(await screen.findByText("Enter a positive number.")).toBeTruthy();
  });

  it("links only to verified protocol app hosts", async () => {
    await mountAt("/asset/NVDA");
    await screen.findByText(/Buy PT-NVDA/);
    const hosts = [...document.querySelectorAll("a[target=_blank]")].map((a) => new URL((a as HTMLAnchorElement).href).host);
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) expect(["app.pendle.finance", "app.morpho.org", "app.uniswap.org", "app.spark.finance", "app.beefy.com", "app.steer.finance", "robinhoodchain.blockscout.com"]).toContain(h);
    for (const a of document.querySelectorAll("a[target=_blank]")) expect(a.getAttribute("rel")).toContain("noopener");
  });
});

describe("alerts", () => {
  it("a price alert that is already crossed fires, shows a banner and is stored locally", async () => {
    await mountAt("/asset/NVDA");
    const summary = await screen.findByText("Set an alert");
    fireEvent.click(summary);
    const box = summary.closest("details")!;
    fireEvent.change(within(box).getByLabelText("Direction"), { target: { value: "ABOVE" } });
    fireEvent.change(within(box).getByLabelText("Price in USD"), { target: { value: "1" } });
    fireEvent.click(within(box).getByRole("button", { name: "Create alert" }));
    expect(await screen.findByText("Alert saved.")).toBeTruthy();
    expect(await screen.findByText("Alert:", {}, { timeout: 4000 })).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem("skein.alerts") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].triggeredAt).toBeTypeOf("number");
  });
});

describe("shell", () => {
  it("theme toggle sets and remembers the theme", async () => {
    await mountAt("/about");
    // Dark is the default look; the toggle switches to light and remembers it.
    const btn = screen.getByRole("button", { name: /light/i });
    fireEvent.click(btn);
    expect(document.documentElement.dataset.skeinTheme).toBe("light");
    expect(localStorage.getItem("skein.theme")).toBe("light");
  });

  it("a pasted wallet address never reaches the URL or storage", async () => {
    const { calls } = await mountAt("/");
    // The home hero's wallet research box.
    fireEvent.change(screen.getByLabelText("Wallet address"), { target: { value: WALLET } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Analyze wallet/ }));
    });
    await waitFor(() => expect(location.pathname).toBe("/wallet"));
    expect(location.href.toLowerCase()).not.toContain(WALLET.slice(2).toLowerCase());
    expect(JSON.stringify({ ...localStorage }).toLowerCase()).not.toContain(WALLET.slice(2).toLowerCase());
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/portfolio/"))).toBe(true));
  });
});

describe("wallet connect (read-only)", () => {
  const USER = "0x00000000000000000000000000000000000000aa";

  /** A fake EIP-6963 wallet that records every request; it answers address and chain reads only. */
  function fakeWallet() {
    const reqs: { method: string; params?: unknown[] }[] = [];
    const provider = {
      async request(a: { method: string; params?: unknown[] }) {
        reqs.push(a);
        if (a.method === "eth_requestAccounts" || a.method === "eth_accounts") return [USER];
        if (a.method === "eth_chainId") return "0x1237";
        throw new Error(`unexpected ${a.method}`);
      },
      on() {},
      removeListener() {},
    };
    const announce = () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "u-1", name: "Test Wallet", icon: "data:image/png;base64,AA==", rdns: "test.wallet" }, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    return { reqs, cleanup: () => window.removeEventListener("eip6963:requestProvider", announce) };
  }

  it("connects a discovered wallet and only ever reads the address and the chain id", async () => {
    const w = fakeWallet();
    try {
      await mountAt("/asset/NVDA");
      fireEvent.click((await screen.findAllByRole("button", { name: "Connect wallet" }))[0]!);
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: /Test Wallet/ }));
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(w.reqs.some((r) => r.method === "eth_requestAccounts")).toBe(true));
      expect(new Set(w.reqs.map((r) => r.method))).toEqual(new Set(w.reqs.map((r) => r.method).filter((m) => ["eth_requestAccounts", "eth_accounts", "eth_chainId"].includes(m))));
      expect(screen.queryByRole("button", { name: "Swap" })).toBeNull();
      expect(JSON.stringify(localStorage)).not.toContain(USER.slice(2));
    } finally {
      w.cleanup();
    }
  });
});

describe("home command line", () => {
  it("reads wallets, assets and short commands", async () => {
    const { parseCommand } = await import("./components/CommandHero");
    const list = [
      { key: "4663:0xa", symbol: "NVDA", name: "NVIDIA • Robinhood Token", address: "0x000000000000000000000000000000000000000a", type: "STOCK_TOKEN", decimals: 18 },
      { key: "4663:0xb", symbol: "SPY", name: "SPDR S&P 500 ETF Trust", address: "0x000000000000000000000000000000000000000b", type: "STOCK_TOKEN", decimals: 18 },
    ] as never[];
    expect(parseCommand("0x00000000000000000000000000000000000000aa", list)).toEqual({ kind: "wallet", address: "0x00000000000000000000000000000000000000aa" });
    expect(parseCommand("0x000000000000000000000000000000000000000A", list)).toMatchObject({ kind: "asset", asset: { symbol: "NVDA" } });
    expect(parseCommand("earn yield on nvda", list)).toMatchObject({ kind: "intent", intent: "EARN", asset: { symbol: "NVDA" } });
    expect(parseCommand("> borrow against SPY", list)).toMatchObject({ kind: "intent", intent: "BORROW", asset: { symbol: "SPY" } });
    // Skein is read-only: swap and bridge are not commands.
    expect(parseCommand("swap 1 NVDA to USDG", list)).toEqual({ kind: "none" });
    expect(parseCommand("bridge", list)).toEqual({ kind: "none" });
    expect(parseCommand("nvidia", list)).toMatchObject({ kind: "asset", asset: { symbol: "NVDA" } });
    expect(parseCommand("hello world", list)).toEqual({ kind: "none" });
    expect(parseCommand("0x123", list)).toEqual({ kind: "none" });
  });
});

describe("tracked wallets", () => {
  it("stores a wallet only on an explicit Track, sanitises the label, and removes it", async () => {
    const { cleanLabel } = await import("./tracked");
    expect(cleanLabel("  Fund‮ A\u0000  ")).toBe("Fund A");
    expect(cleanLabel("x".repeat(40))).toHaveLength(24);
    localStorage.clear();
    const WALLET2 = "0x00000000000000000000000000000000000000bb";
    await mountAt("/tracked");
    expect(localStorage.getItem("skein.tracked")).toBeNull();
    fireEvent.change(screen.getByLabelText("Wallet address"), { target: { value: WALLET2 } });
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Desk" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Track/ }));
    });
    expect(JSON.parse(localStorage.getItem("skein.tracked") ?? "[]")).toMatchObject([{ address: WALLET2, label: "Desk" }]);
    expect(location.href.toLowerCase()).not.toContain(WALLET2.slice(2));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop tracking" }));
    });
    expect(JSON.parse(localStorage.getItem("skein.tracked") ?? "[]")).toEqual([]);
  });
});
