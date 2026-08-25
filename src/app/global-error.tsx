"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary, used only when the root layout itself fails.
 *
 * It replaces the whole document — which is why it renders its own <html> and
 * <body> — so it cannot rely on the app's providers, fonts, or stylesheet.
 * Everything here is inline for that reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[inventory-manager] fatal error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f7f8fa",
          color: "#1a1c22",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <main style={{ maxWidth: "28rem", padding: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
            The application failed to start
          </h1>
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.875rem",
              lineHeight: 1.6,
              color: "#5b606b",
            }}
          >
            An unrecoverable error occurred while rendering the page.
            {error.digest ? ` Reference: ${error.digest}.` : ""}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.5rem 1.25rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              color: "#ffffff",
              background: "#4f46e5",
              border: "none",
              borderRadius: "0.5rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
