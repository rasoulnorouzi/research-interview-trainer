import { createRoot } from "react-dom/client";
import { AdminApp } from "./AdminApp";
import "../src/index.css";

// No StrictMode: same reason as src/main.tsx. This page has no realtime
// session or microphone to double-open, but every screen fires an API call
// on mount, and StrictMode's dev-mode double-invoke would double those too.
createRoot(document.getElementById("root")!).render(<AdminApp />);
