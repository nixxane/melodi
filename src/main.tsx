import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Desktop feel: no browser context menu in production builds (except in text fields).
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.closest("input, textarea")) return;
    e.preventDefault();
  });
}
