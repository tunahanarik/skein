import { linkProps, useRoute } from "./router";
import { shortAddr } from "./format";
import { AboutPage } from "./pages/About";
import { AssetPage } from "./pages/Asset";
import { CoveragePage } from "./pages/Coverage";
import { HomePage } from "./pages/Home";
import { WalletPage } from "./pages/Wallet";
import { useWallet, WalletProvider } from "./wallet";

function Header() {
  const route = useRoute();
  const w = useWallet();
  const is = (n: string) => (route.name === n ? "active" : undefined);
  return (
    <header className="top">
      <div className="shell">
        <a className="brand" {...linkProps("/")}>
          <img src="/favicon.svg" alt="" />
          Waypoint
        </a>
        <nav className="main" aria-label="Main">
          <a className={is("home")} {...linkProps("/")}>
            Explore
          </a>
          <a className={is("wallet")} {...linkProps("/wallet")}>
            Wallet
          </a>
          <a className={is("coverage")} {...linkProps("/coverage")}>
            Coverage
          </a>
          <a className={is("about")} {...linkProps("/about")}>
            How it works
          </a>
        </nav>
        <span className="spacer" />
        {w.address ? (
          <a className="btn small" {...linkProps("/wallet")} title="Viewing this address (read-only)">
            {shortAddr(w.address)}
          </a>
        ) : null}
        <span className="readonly-pill" title="This app never asks for a signature or a transaction.">
          Read-only
        </span>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="bottom">
      <div className="shell">
        <p>
          Read-only information about Robinhood Chain assets and third-party protocols (Morpho, Pendle, Uniswap v3). Nothing here is executed, signed or
          recommended, and nothing is financial advice. Rates and quotes are indicative and change; always check the protocol itself.
        </p>
        <p>Not affiliated with or endorsed by Robinhood. Stock Tokens are not offered to US persons and are restricted in some jurisdictions.</p>
      </div>
    </footer>
  );
}

function Page() {
  const route = useRoute();
  switch (route.name) {
    case "home":
      return <HomePage />;
    case "asset":
      return <AssetPage key={route.ref} assetRef={route.ref} />;
    case "wallet":
      return <WalletPage />;
    case "coverage":
      return <CoveragePage />;
    case "about":
      return <AboutPage />;
    default:
      return (
        <div className="empty">
          <h1>Not found</h1>
          <p>
            <a {...linkProps("/")}>Back to explore</a>
          </p>
        </div>
      );
  }
}

export function App() {
  return (
    <WalletProvider>
      <Header />
      <main>
        <div className="shell">
          <Page />
        </div>
      </main>
      <Footer />
    </WalletProvider>
  );
}
