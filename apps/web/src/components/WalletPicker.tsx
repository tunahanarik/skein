import { useI18n } from "../i18n";
import { KNOWN_WALLETS, knownWallet, ROBINHOOD_WALLET, useWallet } from "../wallet";
import { Icon } from "./icons";
import { Modal } from "./Modal";

/**
 * Connect a wallet: wallets found in this browser (EIP-6963) first, then Robinhood Wallet (the
 * official mobile wallet, which opens the site in its built-in browser), then other EVM wallets
 * that work with Robinhood Chain, each with its official download page.
 */
export function WalletPicker() {
  const { t } = useI18n();
  const w = useWallet();
  if (!w.pickerOpen) return null;
  const detectedIds = new Set(w.wallets.map((x) => knownWallet(x)?.id).filter(Boolean));
  const others = KNOWN_WALLETS.filter((k) => !detectedIds.has(k.id));
  return (
    <Modal title={t("picker.title")} onClose={w.closePicker}>
      <div className="wp">
        <section className="wp-sec">
          <div className="wp-h">
            <span>{t("picker.detected")}</span>
            <span className="spacer" />
            <span className="wp-n">{w.wallets.length}</span>
          </div>
          {w.wallets.length > 0 ? (
            <div className="wp-list">
              {w.wallets.map((x) => (
                <button key={x.id} className="wp-row" disabled={w.connecting} onClick={() => void w.connect(x.id)}>
                  {x.icon ? <img src={x.icon} alt="" width={32} height={32} /> : <span className="wp-mono">{x.name.slice(0, 2)}</span>}
                  <span className="wp-name">{x.name}</span>
                  <span className="wp-tag on">{t("picker.found")}</span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="wp-empty">{t("picker.none")}</div>
          )}
          {w.connecting && <div className="wp-wait">{t("walletEntry.waiting")}</div>}
        </section>

        <section className="wp-rh">
          <img src={ROBINHOOD_WALLET.icon} alt="" width={44} height={44} />
          <div className="wp-rh-txt">
            <div className="wp-rh-name">
              {ROBINHOOD_WALLET.name} <span className="wp-tag">{t("picker.official")}</span>
            </div>
            <div className="wp-rh-sub">{t("picker.rhText")}</div>
            <div className="wp-stores">
              <a href={ROBINHOOD_WALLET.appStore} target="_blank" rel="noopener noreferrer">
                App Store ↗
              </a>
              <a href={ROBINHOOD_WALLET.playStore} target="_blank" rel="noopener noreferrer">
                Google Play ↗
              </a>
            </div>
          </div>
        </section>

        {others.length > 0 && (
          <section className="wp-sec">
            <div className="wp-h">
              <span>{t("picker.others")}</span>
            </div>
            <div className="wp-grid">
              {others.map((k) => (
                <a key={k.id} className="wp-get" href={k.url} target="_blank" rel="noopener noreferrer">
                  <img src={k.icon} alt="" width={26} height={26} />
                  <span className="wp-name">{k.name}</span>
                  <span className="wp-install">{t("picker.install")} ↗</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {w.error && <div className="wp-err">{t(w.error)}</div>}
        <div className="wp-note">{t("walletEntry.footnote")}</div>
      </div>
    </Modal>
  );
}
