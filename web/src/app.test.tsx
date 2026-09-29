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
    expect(localStorage.getItem("hoodmap.lang")).toBe("tr");
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
    const stored = JSON.parse(localStorage.getItem("hoodmap.alerts") ?? "[]");
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
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("hoodmap.theme")).toBe("light");
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
      fireEvent.click((await screen.findAllByRole("button", { name: "Connect wallet" }))[0]!);
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: /Test Wallet/ }));
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Compare routes" }));
      });
      // Swap buttons in the quoted route table (the header's quick "Swap" opens the side panel instead).
      const quoted = (await screen.findAllByRole("table"))[0]!;
      const swapButtons = await within(quoted).findAllByRole("button", { name: "Swap" });
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

describe("bridge", () => {
  it("quotes automatically, hides look-alikes, approves the exact amount to the pinned diamond, sends, and tracks until done", async () => {
    const { LIFI_DIAMONDS } = await import("./bridge/diamonds");
    const USER = "0x00000000000000000000000000000000000000aa";
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const DIAMOND = LIFI_DIAMONDS[8453]!.diamond;
    const quotes: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input, "http://localhost");
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.host === "li.quest") {
        const token = (chainId: number, address: string, symbol: string, decimals: number) => ({ chainId, address, symbol, name: symbol, decimals, priceUSD: "1", verificationStatus: "verified", logoURI: "https://static.debank.com/x.png" });
        if (url.pathname === "/v1/chains") return json({ chains: [8453, 4663].map((id) => ({ id, mainnet: true, chainType: "EVM", name: id === 8453 ? "Base" : "Robinhood Chain", coin: "ETH", diamondAddress: LIFI_DIAMONDS[id]!.diamond, logoURI: "https://raw.githubusercontent.com/lifinance/types/main/x.svg" })) });
        if (url.pathname === "/v1/tokens") {
          const c = url.searchParams.get("chains")!;
          return json({ tokens: { [c]: c === "8453" ? [token(8453, USDC, "USDC", 6)] : [token(4663, "0x0000000000000000000000000000000000000000", "ETH", 18), token(4663, "0x0A3B763d00000000000000000000000000000000", "USDG", 6)] } });
        }
        if (url.pathname === "/v1/quote") {
          quotes.push(url.searchParams);
          const who = url.searchParams.get("fromAddress")!;
          expect(url.searchParams.get("toAddress")).toBe(who);
          return json({
            tool: "across",
            toolDetails: { name: "AcrossV4" },
            action: { fromChainId: 8453, toChainId: 4663, fromToken: token(8453, USDC, "USDC", 6), toToken: token(4663, "0x0000000000000000000000000000000000000000", "ETH", 18), fromAmount: url.searchParams.get("fromAmount"), fromAddress: who, toAddress: who },
            estimate: { approvalAddress: DIAMOND, toAmount: "18000000000000000", toAmountMin: "17900000000000000", executionDuration: 2, feeCosts: [{ amountUSD: "0.16", included: true }], gasCosts: [{ amountUSD: "0.01" }] },
            transactionRequest: { from: who, to: DIAMOND, data: "0x4c279d6b", value: "0x0", chainId: 8453 },
          });
        }
        if (url.pathname === "/v1/status") return json({ status: "DONE", substatus: "COMPLETED", receiving: { txHash: `0x${"b".repeat(64)}` } });
      }
      if (url.pathname === "/api/assets") return json({ assets: [] });
      return json({});
    });
    const reqs: { method: string; params?: unknown[] }[] = [];
    let allowance = 0n;
    const provider = {
      async request(a: { method: string; params?: unknown[] }) {
        reqs.push(a);
        if (a.method === "eth_requestAccounts") return [USER];
        if (a.method === "eth_chainId") return "0x2105"; // Base
        if (a.method === "eth_call") {
          const data = (a.params![0] as { data: string }).data;
          return `0x${(data.startsWith("0xdd62ed3e") ? allowance : 10n ** 12n).toString(16).padStart(64, "0")}`;
        }
        if (a.method === "eth_sendTransaction") {
          if ((a.params![0] as { to: string }).to === USDC) allowance = 10n ** 30n;
          return `0x${String(reqs.length).padStart(64, "0")}`;
        }
        if (a.method === "eth_getTransactionReceipt") return { status: "0x1" };
        throw new Error(`unexpected ${a.method}`);
      },
      on() {},
      removeListener() {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u-2", name: "Test Wallet", icon: "data:image/png;base64,AA==", rdns: "test.wallet" }, provider } }));
    window.addEventListener("eip6963:requestProvider", announce);
    try {
      history.pushState(null, "", "/bridge");
      render(<App />);
      const main = () => screen.getAllByRole("button").find((b) => b.classList.contains("big"))!;

      // Token buttons show the chosen tokens; the Robinhood side never offers the look-alike USDG.
      const fromBtn = await screen.findByRole("button", { name: "Token to send" });
      await waitFor(() => expect(fromBtn.textContent).toContain("USDC"), { timeout: 3000 });
      fireEvent.click(screen.getByRole("button", { name: "Token to receive" }));
      const dialog = await screen.findByRole("dialog");
      const list = within(dialog).getByRole("listbox", { name: "Select token" });
      await waitFor(() => expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["ETHETH"]));
      fireEvent.click(within(list).getAllByRole("option")[0]!);

      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "50" } });
      // Without a wallet the quote is a preview for a throwaway address.
      await screen.findByText(/AcrossV4/, {}, { timeout: 3000 });
      expect(quotes.at(-1)!.get("fromAddress")).not.toBe(USER);

      fireEvent.click(main());
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: /Test Wallet/ }));
      });
      await waitFor(() => expect(quotes.at(-1)!.get("fromAddress")).toBe(USER), { timeout: 3000 });
      await waitFor(() => expect(main().textContent).toMatch(/^1\. Allow USDC/), { timeout: 3000 });
      await act(async () => {
        fireEvent.click(main());
      });
      await waitFor(() => expect(main().textContent).toBe("Bridge Base → Robinhood Chain"), { timeout: 3000 });
      await act(async () => {
        fireEvent.click(main());
      });
      await screen.findByText(/Bridge complete/, {}, { timeout: 3000 });

      const sent = reqs.filter((r) => r.method === "eth_sendTransaction").map((r) => r.params![0] as { to: string; data: string; from: string });
      expect(sent).toHaveLength(2);
      expect(sent[0]!.to).toBe(USDC);
      expect(sent[0]!.data).toBe(`0x095ea7b3${DIAMOND.slice(2).toLowerCase().padStart(64, "0")}${(50_000_000n).toString(16).padStart(64, "0")}`);
      expect(sent[1]!.to).toBe(DIAMOND);
      expect(sent[1]!.from.toLowerCase()).toBe(USER);
      expect(reqs.some((r) => /sign/i.test(r.method))).toBe(false);
    } finally {
      window.removeEventListener("eip6963:requestProvider", announce);
    }
  });
});
