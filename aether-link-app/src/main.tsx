import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isMobileViewerPath } from "./domain/mobileViewer";
import { VideoConsultationGuest } from "./components/VideoConsultation";
import "./styles.css";

if (isMobileViewerPath(window.location.pathname) && window.isSecureContext && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/viewer-sw.js").catch(() => undefined);
  }, { once: true });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.pathname.replace(/\/+$/,"")==="/video-support"?<VideoConsultationGuest/>:<App/>}
  </React.StrictMode>,
);
