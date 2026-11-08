import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../ui/styles.css";
import "./ui/analytics.css";
import { AnalyticsApp } from "./ui/AnalyticsApp.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");
createRoot(root).render(
  <StrictMode>
    <AnalyticsApp />
  </StrictMode>,
);
