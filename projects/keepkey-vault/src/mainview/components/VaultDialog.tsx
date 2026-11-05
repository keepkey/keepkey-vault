import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Z } from "../lib/z-index";
import { useUiTranslation } from "../i18n/ui";
import "./AddVaultDialog.css";

/** Viewport-bounded shell: only the body scrolls; close and actions stay visible. */
export function VaultDialog({
  title,
  children,
  footer,
  onClose,
  busy = false,
  resetKey,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  busy?: boolean;
  resetKey?: string;
}) {
  const uiText = useUiTranslation();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
    panel.current?.focus();
  }, [resetKey]);
  return createPortal(
    <div
      className="vault-add-overlay"
      style={{ zIndex: Z.dialog }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        className="vault-add-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            if (!busy) onClose();
          }
          if (e.key !== "Tab") return;
          const controls = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href]"
            ) || []
          ).filter((el) => el.getClientRects().length);
          const first = controls[0],
            last = controls[controls.length - 1];
          const focused = document.activeElement as HTMLElement;
          if (
            !controls.includes(focused) ||
            (e.shiftKey && focused === first) ||
            (!e.shiftKey && focused === last)
          ) {
            e.preventDefault();
            (e.shiftKey ? last : first)?.focus();
          }
        }}
      >
        <header>
          <div>
            <span className="vault-add-eyebrow">
              {uiText("SHARED ACCOUNT")}
            </span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            className="vault-add-close"
            disabled={busy}
            aria-label={uiText("Close vault dialog")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="vault-dialog-body" ref={body}>
          {children}
        </div>
        <footer className="vault-add-actions">{footer}</footer>
      </div>
    </div>,
    document.body
  );
}
