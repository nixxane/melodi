import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  /** Short key hint shown on the right. */
  hint?: string;
  onClick: () => void;
  danger?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** State for a single, app-styled context menu. */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const open = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

interface Props {
  menu: MenuState | null;
  onClose: () => void;
}

export function ContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
    ref.current.querySelector<HTMLButtonElement>(".ctx-item")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // j/k or arrows move between items.
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".ctx-item") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (step && items.length) {
        e.preventDefault();
        e.stopPropagation();
        items[(i + step + items.length) % items.length].focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={`ctx-item ${it.danger ? "danger" : ""}`}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          <span className="ctx-label">{it.label}</span>
          {it.hint ? <span className="ctx-hint">{it.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
