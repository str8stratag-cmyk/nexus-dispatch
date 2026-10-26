import { createRoot } from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./components/error-boundary";
import "./index.css";
// Saturday monitor shell (rail / top / queue / map / detail / strip).
import "./styles/monitor.css";

// Default to dark mode for dispatch console
document.documentElement.classList.add("dark");

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
