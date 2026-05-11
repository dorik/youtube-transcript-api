"use client";

import { useEffect } from "react";

/**
 * App Router root error boundary. Catches anything that escapes per-route
 * `error.tsx` boundaries (or runs before they mount). Renders its own
 * `<html>` because Next replaces the whole document on this fallback.
 *
 * In development we log the error so the failure is visible in devtools.
 * In production we stay quiet — the user already sees the fallback UI;
 * structured logging (Sentry, etc.) would attach here when added.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console -- dev-only diagnostic; visible to user via fallback UI in prod
      console.error("Uncaught error", error);
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.5rem" }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: "0.875rem", color: "#666", marginBottom: "1.5rem" }}>
              The app hit an unexpected error. Try again, or go back home.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
              <button
                type="button"
                onClick={reset}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#000",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
              <a
                href="/"
                style={{
                  padding: "0.5rem 1rem",
                  background: "#fff",
                  color: "#000",
                  border: "1px solid #ccc",
                  borderRadius: 6,
                  textDecoration: "none",
                  display: "inline-block",
                }}
              >
                Go home
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
