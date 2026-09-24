import { useEffect } from "react";
import { shortAddr } from "./format";
import { I18nProvider, LANGS, useI18n, type Lang } from "./i18n";
import { AboutPage } from "./pages/About";
import { AssetPage } from "./pages/Asset";
import { CoveragePage } from "./pages/Coverage";
import { HomePage } from "./pages/Home";
import { WalletPage } from "./pages/Wallet";
import { linkProps, useRoute } from "./router";
import { useWallet, WalletProvider } from "./wallet";

function LanguagePicker() {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="lang">
      <span className="sr-only">{t("shell.language")}</span>
      <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("shell.language")}>
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.code.toUpperCase()} · {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Header() {
  const { t } = useI18n();
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
            {t("nav.explore")}
          </a>
          <a className={is("wallet")} {...linkProps("/wallet")}>
            {t("nav.wallet")}
          </a>
          <a className={is("coverage")} {...linkProps("/coverage")}>
            {t("nav.coverage")}
          </a>
          <a className={is("about")} {...linkProps("/about")}>
            {t("nav.about")}
          </a>
        </nav>
        <span className="spacer" />
        {w.address ? (
          <a className="btn small" {...linkProps("/wallet")} title={t("shell.viewing")}>
            {shortAddr(w.address)}
          </a>
        ) : null}
        <LanguagePicker />
        <span className="readonly-pill" title={t("shell.readOnlyTitle")}>
          {t("shell.readOnly")}
        </span>
      </div>
    </header>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="bottom">
      <div className="shell">
        <p>{t("footer.p1")}</p>
        <p>{t("footer.p2")}</p>
      </div>
    </footer>
  );
}

function Page() {
  const { t } = useI18n();
  const route = useRoute();
  useEffect(() => {
    const title = route.name === "asset" ? route.ref.slice(0, 16) : t(`title.${route.name}`);
    document.title = `${title} · Waypoint`;
  }, [route, t]);
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
          <h1>{t("notFound.title")}</h1>
          <p>
            <a {...linkProps("/")}>{t("notFound.back")}</a>
          </p>
        </div>
      );
  }
}

export function App() {
  return (
    <I18nProvider>
      <WalletProvider>
        <Header />
        <main>
          <div className="shell">
            <Page />
          </div>
        </main>
        <Footer />
      </WalletProvider>
    </I18nProvider>
  );
}
