import { useEffect, useState } from "react";

/** Width below which the phone layout kicks in (see the matching @media in styles.css). */
export const PHONE_QUERY = "(max-width: 720px)";

/** True while the window is phone-sized. */
export function usePhone() {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY);
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}
