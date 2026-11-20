import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { applyVisuals, readSettings } from "./lib/useSettings";
import { isMobile, isWeb } from "./lib/platform";
import "./styles.css";

// Apply the saved theme before the first paint (no flash of the default theme).
applyVisuals(readSettings());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Web: installable app + instant start (see public/sw.js).
if (isWeb && import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker failed", e));
  });
}

// Phones get their own layout (see .app.mobile in styles.css).
if (isMobile) document.documentElement.classList.add("mobile");

// Desktop feel: no browser context menu in production builds (except in text fields).
if (import.meta.env.PROD && !isMobile) {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.closest("input, textarea")) return;
    e.preventDefault();
  });
}
