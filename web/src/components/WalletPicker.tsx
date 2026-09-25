import { useI18n } from "../i18n";
import { useWallet } from "../wallet";
import { Modal } from "./Modal";

/** Where to get a browser-extension wallet that supports Robinhood Chain (official sites). */
const INSTALL = [
  { name: "MetaMask", url: "https://metamask.io/download" },
  { name: "Rabby", url: "https://rabby.io/" },
  { name: "OKX Wallet", url: "https://web3.okx.com/download" },
  { name: "Coinbase Wallet", url: "https://wallet.coinbase.com/" },
  { name: "Trust Wallet", url: "https://trustwallet.com/download" },
];

/** Lists the wallets this browser announced (EIP-6963) and connects the chosen one. */
export function WalletPicker() {
  const { t } = useI18n();
  const w = useWallet();
  if (!w.pickerOpen) return null;
  return (
    <Modal title={t("picker.title")} onClose={w.closePicker}>
      <div style={{ display: "grid", gap: 12 }}>
        {w.wallets.length > 0 ? (
          <>
            <div className="muted small">{t("picker.detected")}</div>
            <div className="wallet-list">
              {w.wallets.map((x) => (
                <button key={x.id} className="wallet-opt" disabled={w.connecting} onClick={() => void w.connect(x.id)}>
                  {x.icon ? <img src={x.icon} alt="" width={28} height={28} /> : <span className="avatar">{x.name.slice(0, 2)}</span>}
                  <span>{x.name}</span>
                </button>
              ))}
            </div>
            {w.connecting && <div className="small muted">{t("walletEntry.waiting")}</div>}
          </>
        ) : (
          <>
            <div className="small">{t("picker.none")}</div>
            <div className="wallet-list">
              {INSTALL.map((x) => (
                <a key={x.name} className="wallet-opt" href={x.url} target="_blank" rel="noopener noreferrer">
                  <span className="avatar">{x.name.slice(0, 2)}</span>
                  <span>{x.name} ↗</span>
                </a>
              ))}
            </div>
          </>
        )}
        {w.error && <div className="small" style={{ color: "var(--bad)" }}>{t(w.error)}</div>}
        <div className="faint small">{t("picker.mobile")}</div>
        <div className="faint small">{t("walletEntry.footnote")}</div>
      </div>
    </Modal>
  );
}
