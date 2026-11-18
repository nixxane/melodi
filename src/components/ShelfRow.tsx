import { useCallback, useEffect, useRef, useState } from "react";

/** Horizontal scroller with hover arrows. */
export function ShelfRow({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update]);

  // Content may change between renders (new shelf items).
  useEffect(update);

  const scrollBy = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div className={`shelf-wrap ${canLeft ? "can-left" : ""} ${canRight ? "can-right" : ""}`}>
      <button className="shelf-arrow left" aria-label="Scroll left" tabIndex={-1} onClick={() => scrollBy(-1)}>
        ◀
      </button>
      <div className="shelf-scroll" ref={ref} onScroll={update}>
        {children}
      </div>
      <button className="shelf-arrow right" aria-label="Scroll right" tabIndex={-1} onClick={() => scrollBy(1)}>
        ▶
      </button>
    </div>
  );
}
