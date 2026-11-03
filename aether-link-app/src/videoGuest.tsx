import React from "react";
import { createRoot } from "react-dom/client";
import { VideoConsultationGuest } from "./components/VideoConsultation";
import "./styles.css";

window.addEventListener("beforeinstallprompt", event=>event.preventDefault());
createRoot(document.getElementById("root")!).render(<React.StrictMode><VideoConsultationGuest/></React.StrictMode>);
