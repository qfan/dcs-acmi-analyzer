import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../i18n/index.ts";
import "./ui/game.css";
import { GameApp } from "./ui/GameApp.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");
createRoot(root).render(
  <StrictMode>
    <GameApp />
  </StrictMode>,
);
