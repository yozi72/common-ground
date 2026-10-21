import type { NextConfig } from "next";

// Security headers. The CSP is tailored to what the app actually loads:
// - scripts/styles: Next's own bundles plus its inline bootstrap (hence
//   'unsafe-inline'; no third-party scripts are loaded). Dev needs eval for HMR.
// - connect: the Supabase project (REST + Realtime websocket) and the app itself.
// - fonts: self-hosted by next/font (no Google Fonts at runtime).
// - workers: the push service worker at /sw.js; manifest at /manifest.json.
// - frame-ancestors 'none' (clickjacking), base-uri/form-action 'self' (the
//   unsubscribe form posts to the app itself), object-src 'none'.
const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseWs = supabase.replace(/^http/, "ws");
const dev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabase} ${supabaseWs}${dev ? " ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*" : ""}`.replace(/\s+/g, " ").trim(),
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const nextConfig: NextConfig = {
  // Every page depends on the signed-in user; nothing here benefits from
  // component caching, and the route handlers must never be cached.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
