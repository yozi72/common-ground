import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ProviderBanner } from "@/components/ProviderBanner";

export const metadata: Metadata = {
  title: "Common Ground",
  description: "Anonymous, moderated text conversations between adults across political differences.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh flex flex-col">
        <a href="#main" className="skip-link">Skip to content</a>
        <ProviderBanner />
        <Nav />
        <main id="main" className="flex-1 w-full max-w-2xl mx-auto px-4 py-6">
          {children}
        </main>
        <footer className="muted text-xs text-center px-4 py-6">
          Conversations are anonymous to the other person, not to the service. Messages are reviewed before delivery; review is imperfect.{" "}
          <a href="/privacy" className="underline">How this works</a>
        </footer>
      </body>
    </html>
  );
}
