import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isMobileViewerPath } from "./domain/mobileViewer";
import "./styles.css";

if (isMobileViewerPath(window.location.pathname) && window.isSecureContext && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/viewer-sw.js").catch(() => undefined);
  }, { once: true });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
