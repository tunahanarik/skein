import type { KeyboardEvent } from "react";

/** Makes a clickable table row reachable and operable from the keyboard (Tab, then Enter or Space). */
export function rowKeys(action: () => void) {
  return {
    tabIndex: 0,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        action();
      }
    },
  };
}
