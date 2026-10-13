import { createWebApp } from "@slugbase/web";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./web.css";

const App = createWebApp({ extensions: [] });

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html has no #root element to mount the web app in");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
