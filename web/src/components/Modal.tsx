import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";

/** Accessible dialog: focus moves in, Escape and the backdrop close it, focus returns on close. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  // Rendered on the page's top layer, so a dialog opened from the side panel is neither clipped nor restyled by it.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="btn small" onClick={onClose} aria-label={t("modal.close")}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
