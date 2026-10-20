// Post-login destination validation. Only a path on this site is allowed; the
// check is done on the fully resolved URL so that normalization tricks such as
// "/a/..//evil.example" (which resolves to a protocol-relative URL) are caught.
export function safeNext(raw: string | null | undefined, siteUrl: string, fallback = "/lobby"): string {
  if (!raw) return fallback;
  let site: URL;
  try { site = new URL(siteUrl); } catch { return fallback; }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\u0000-\u001f\s]/.test(raw)) return fallback;
  let resolved: URL;
  try { resolved = new URL(raw, site); } catch { return fallback; }
  if (resolved.origin !== site.origin) return fallback;
  if (resolved.pathname.startsWith("//") || resolved.pathname.includes("\\")) return fallback;
  const out = resolved.pathname + resolved.search;
  // final belt-and-braces: re-resolving the output must stay on our origin
  try { if (new URL(out, site).origin !== site.origin) return fallback; } catch { return fallback; }
  return out;
}
