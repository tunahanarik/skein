import { useEffect } from "react";
import { shortAddr } from "./format";
import { I18nProvider, LANGS, useI18n, type Lang } from "./i18n";
import { AboutPage } from "./pages/About";
import { AssetPage } from "./pages/Asset";
import { BridgePage } from "./pages/Bridge";
import { ComparePage } from "./pages/Compare";
import { CoveragePage } from "./pages/Coverage";
import { HomePage } from "./pages/Home";
import { WalletPage } from "./pages/Wallet";
import { linkProps, useRoute } from "./router";
import { AlertsProvider } from "./alerts";
import { FiredBanner } from "./components/AlertForm";
import { WalletPicker } from "./components/WalletPicker";
import { useTheme } from "./theme";
import { useWallet, WalletProvider } from "./wallet";

function LanguagePicker() {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="lang">
      <span className="sr-only">{t("shell.language")}</span>
      <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("shell.language")}>
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ThemeToggle() {
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? t("theme.toLight") : t("theme.toDark");
  return (
    <button className="theme-toggle" onClick={toggle} aria-label={label} title={label}>
      <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
    </button>
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
          <a className={is("bridge")} {...linkProps("/bridge")}>
            {t("nav.bridge")}
          </a>
          <a className={is("coverage")} {...linkProps("/coverage")}>
            {t("nav.coverage")}
          </a>
          <a className={is("compare")} {...linkProps("/compare")}>
            {t("nav.compare")}
          </a>
          <a className={is("about")} {...linkProps("/about")}>
            {t("nav.about")}
          </a>
        </nav>
        <span className="spacer" />
        <ThemeToggle />
        <LanguagePicker />
        {w.address && w.source === "connected" ? (
          <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
            <a className="btn small" {...linkProps("/wallet")} title={w.wallet ? `${w.wallet.name} · ${t("shell.viewing")}` : t("shell.viewing")}>
              {w.wallet?.icon && <img src={w.wallet.icon} alt="" width={16} height={16} />}
              {shortAddr(w.address)}
            </a>
            <button className="btn small" onClick={w.clear} title={t("shell.disconnect")} aria-label={t("shell.disconnect")}>
              ⏏
            </button>
          </span>
        ) : (
          <button className="btn small primary" onClick={w.openPicker} title={t("shell.readOnlyTitle")}>
            {t("shell.connect")}
          </button>
        )}
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
    case "bridge":
      return <BridgePage />;
    case "coverage":
      return <CoveragePage />;
    case "about":
      return <AboutPage />;
    case "compare":
      return <ComparePage />;
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
        <AlertsProvider>
          <Header />
          <main>
            <div className="shell">
              <FiredBanner />
              <Page />
            </div>
          </main>
          <Footer />
          <WalletPicker />
        </AlertsProvider>
      </WalletProvider>
    </I18nProvider>
  );
}
