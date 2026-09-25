// @vitest-environment jsdom
/**
 * Web UI over the offline fixture world: the real AssetIntelligenceService answers a fetch stub,
 * so the app renders the same JSON shape the server sends.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toJson } from "../../src/server/json";
import { intelligenceStack } from "../../test/fixtures/intelligence";
import { WALLET } from "../../test/fixtures/world";
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
  document.documentElement.removeAttribute("data-theme");
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

  it("switches to Turkish, with localized numbers, and remembers it", async () => {
    await mountAt("/asset/NVDA");
    await screen.findByText(/Buy PT-NVDA/);
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "tr" } });
    expect(await screen.findByText("NVDA ile PT-NVDA-15OCT2026 al")).toBeTruthy();
    expect(screen.getByText("NVDA teminatıyla USDG borç al")).toBeTruthy();
    expect(document.body.textContent).toContain("%7,28");
    expect(localStorage.getItem("waypoint.lang")).toBe("tr");
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
    const stored = JSON.parse(localStorage.getItem("waypoint.alerts") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].triggeredAt).toBeTypeOf("number");
  });
});

describe("shell", () => {
  it("theme toggle sets and remembers the theme", async () => {
    await mountAt("/about");
    const btn = screen.getByRole("button", { name: /dark/i });
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("waypoint.theme")).toBe("dark");
  });

  it("a pasted wallet address never reaches the URL or storage", async () => {
    const { calls } = await mountAt("/");
    fireEvent.change(screen.getByLabelText("Wallet address"), { target: { value: WALLET } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });
    await waitFor(() => expect(location.pathname).toBe("/wallet"));
    expect(location.href.toLowerCase()).not.toContain(WALLET.slice(2).toLowerCase());
    expect(JSON.stringify({ ...localStorage }).toLowerCase()).not.toContain(WALLET.slice(2).toLowerCase());
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/portfolio/"))).toBe(true));
  });
});

describe("wallet connect and swap", () => {
  const USER = "0x00000000000000000000000000000000000000aa";

  /** A fake EIP-6963 wallet that records every request and answers the calls the swap flow makes. */
  async function fakeWallet() {
    const { decodeFunctionData, encodeFunctionResult } = await import("viem");
    const { erc20Abi, quoterAbi, SWAP_ROUTER, QUOTER_V2 } = await import("./swap/uniswap");
    const reqs: { method: string; params?: unknown[] }[] = [];
    let allowance = 0n;
    const provider = {
      async request(a: { method: string; params?: unknown[] }) {
        reqs.push(a);
        switch (a.method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [USER];
          case "eth_chainId":
            return "0x1237";
          case "eth_call": {
            const { to, data } = a.params![0] as { to: string; data: `0x${string}` };
            if (to.toLowerCase() === QUOTER_V2) return encodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInput", result: [123_000_000n, [], [], 0n] });
            if (to.toLowerCase() === SWAP_ROUTER) return "0x";
            const fn = decodeFunctionData({ abi: erc20Abi, data }).functionName;
            return encodeFunctionResult({ abi: erc20Abi, functionName: fn as "balanceOf", result: fn === "allowance" ? allowance : 10n ** 24n });
          }
          case "eth_sendTransaction": {
            const tx = a.params![0] as { to: string };
            if (tx.to.toLowerCase() !== SWAP_ROUTER) allowance = 10n ** 30n; // the approval
            return `0x${String(reqs.length).padStart(64, "0")}`;
          }
          case "eth_getTransactionReceipt":
            return { status: "0x1" };
          default:
            throw new Error(`unexpected ${a.method}`);
        }
      },
      on() {},
      removeListener() {},
    };
    const announce = () =>
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "u-1", name: "Test Wallet", icon: "data:image/png;base64,AA==", rdns: "test.wallet" }, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    return { reqs, cleanup: () => window.removeEventListener("eip6963:requestProvider", announce) };
  }

  it("connects a discovered wallet, approves the exact amount, then swaps with a minimum output", async () => {
    const w = await fakeWallet();
    try {
      await mountAt("/asset/NVDA");
      fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: /Test Wallet/ }));
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Compare routes" }));
      });
      const swapButtons = await screen.findAllByRole("button", { name: "Swap" });
      await act(async () => {
        fireEvent.click(swapButtons[0]!);
      });
      const dialog = await screen.findByRole("dialog");
      const approve = await within(dialog).findByRole("button", { name: /^1\. Allow NVDA/ });
      await act(async () => {
        fireEvent.click(approve);
      });
      const swap = await within(dialog).findByRole("button", { name: "Swap" });
      await act(async () => {
        fireEvent.click(swap);
      });
      await within(dialog).findByText(/Swap confirmed/);

      const sent = w.reqs.filter((r) => r.method === "eth_sendTransaction").map((r) => r.params![0] as { to: string; data: string; value: string; from: string });
      expect(sent).toHaveLength(2);
      const { SWAP_ROUTER } = await import("./swap/uniswap");
      expect(sent[0]!.data.slice(0, 10)).toBe("0x095ea7b3"); // approve
      expect(sent[1]!.to.toLowerCase()).toBe(SWAP_ROUTER);
      expect(sent.every((t) => t.value === "0x0" && t.from.toLowerCase() === USER)).toBe(true);
      // Only allowlisted wallet methods; never message signing.
      expect(w.reqs.some((r) => /sign/i.test(r.method))).toBe(false);
      // The address is not stored or put in the URL.
      expect(location.href.toLowerCase()).not.toContain(USER.slice(2));
      expect(JSON.stringify({ ...localStorage }).toLowerCase()).not.toContain(USER.slice(2));
    } finally {
      w.cleanup();
    }
  });
});
