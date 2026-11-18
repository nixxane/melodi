import type { Toast } from "../types";

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
          <span className="toast-tag">{t.kind === "error" ? "[ERR]" : "[ OK]"}</span>
          <span className="toast-msg">{t.message}</span>
          <button className="row-btn" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">
            x
          </button>
        </div>
      ))}
    </div>
  );
}
