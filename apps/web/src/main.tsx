import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">TMap V2</p>
        <h1>Clean self-hosted foundation is running.</h1>
        <p>Next: map renderer, location pipeline, search, routing and server-side request control.</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
