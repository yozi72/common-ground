import type { Metadata, Viewport } from "next";
import { Nunito, Fredoka } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ProviderBanner } from "@/components/ProviderBanner";

const body = Nunito({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const display = Fredoka({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Common Ground",
  description: "Anonymous, moderated text conversations between adults across political differences.",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "Common Ground", statusBarStyle: "default" },
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#fbf7f0" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body className="min-h-dvh flex flex-col">
        <a href="#main" className="skip-link">Skip to content</a>
        <ProviderBanner />
        <Nav />
        <main id="main" className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 sm:py-8 pb-24 sm:pb-8">
          {children}
        </main>
        <footer className="muted text-xs text-center px-4 py-6">
          Anonymous to the other person, not to the service. Messages are checked before delivery; checks aren&apos;t perfect.{" "}
          <a href="/privacy" className="underline">How this works</a>
        </footer>
      </body>
    </html>
  );
}
