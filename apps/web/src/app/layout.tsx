import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Sentinel", template: "%s · Sentinel" },
  description: "Multi-region uptime and synthetic monitoring with consensus-based incident detection.",
  icons: {
    icon: [
      {
        url:
          "data:image/svg+xml," +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#08090c"/><circle cx="16" cy="16" r="6" fill="none" stroke="#10b981" stroke-width="2.5"/><circle cx="16" cy="16" r="2" fill="#10b981"/></svg>`,
          ),
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#08090c",
  width: "device-width",
  initialScale: 1,
};

/*
 * Scroll entrances start hidden, and the only thing that ever reveals them is
 * JavaScript. Stamping `.js` on <html> before first paint is what lets the
 * stylesheet apply `opacity: 0` exclusively to visitors who will also get the
 * effect that undoes it — without this, scripting-disabled visitors would meet
 * a page of permanently invisible sections. It has to run inline and first:
 * anything deferred would land after the paint it exists to configure.
 */
const JS_ENABLED = "document.documentElement.classList.add('js')";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <script dangerouslySetInnerHTML={{ __html: JS_ENABLED }} />
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
