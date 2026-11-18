import { useEffect, useState } from "react";

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Braille terminal spinner. */
export function Spinner({ className = "" }: { className?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
    return () => window.clearInterval(t);
  }, []);
  return (
    <span className={`spinner ${className}`} aria-hidden="true">
      {FRAMES[i]}
    </span>
  );
}
