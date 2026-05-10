import fs from "fs";
import path from "path";
import { URL } from "url";
import crypto from "crypto";

/**
 * Safely resolve a URL (relative or absolute) against a base URL.
 */
export function resolveUrl(base: string, href: string): string | null {
  if (!href || href.startsWith("data:") || href.startsWith("blob:") || href.startsWith("javascript:")) {
    return null;
  }
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Convert an asset URL to a local relative file path, mirroring the URL structure.
 * e.g. https://example.com/assets/style.css → example.com/assets/style.css
 */
export function urlToLocalPath(assetUrl: string): string {
  const parsed = new URL(assetUrl);
  // Use hostname + pathname, strip leading slash
  let filePath = parsed.hostname + parsed.pathname;
  // Sanitize path separators
  filePath = filePath.replace(/\\/g, "/");
  // Remove trailing slash
  if (filePath.endsWith("/")) {
    filePath += "index.html";
  }
  return filePath;
}

/**
 * Strip query strings and fragments from a URL path to get a clean file path.
 * If a query string is present, a short hash of it is appended before the
 * extension so that different query-parameterised URLs (e.g. Next.js
 * /_next/image?url=...&w=128) map to different local files.
 */
export function sanitizePath(urlPath: string): string {
  const [pathPart, rest] = urlPath.split("?");
  const cleanPath = (pathPart ?? urlPath).split("#")[0] ?? urlPath;
  if (!rest) return cleanPath;

  // Shorten the query into an 8-char hex hash so the filename stays manageable
  const queryHash = crypto
    .createHash("sha1")
    .update(rest)
    .digest("hex")
    .slice(0, 8);

  const ext = path.extname(cleanPath);
  if (ext) {
    return cleanPath.slice(0, cleanPath.length - ext.length) + `-${queryHash}` + ext;
  }
  return cleanPath + `-${queryHash}`;
}

/**
 * Ensure a directory exists (recursive mkdir).
 */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Parse a srcset attribute string into an array of URLs.
 * e.g. "img-1x.png 1x, img-2x.png 2x" → ["img-1x.png", "img-2x.png"]
 */
export function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((url): url is string => !!url && url.length > 0);
}

/**
 * Extract all url(...) and @import references from a CSS string.
 * Returns a list of raw URL strings found.
 */
export function extractCssUrls(css: string): string[] {
  const urls: string[] = [];
  // Match url('...'), url("..."), url(...)
  const urlRegex = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(css)) !== null) {
    const url = match[2];
    if (url) urls.push(url);
  }
  // Match @import '...' or @import "..."
  const importRegex = /@import\s+(['"])(.*?)\1/gi;
  while ((match = importRegex.exec(css)) !== null) {
    const url = match[2];
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * Rewrite all url(...) and @import references in CSS text, replacing
 * original URLs with local relative paths using the provided map.
 */
export function rewriteCssUrls(
  css: string,
  assetMap: Map<string, string>,
  cssLocalPath: string
): string {
  // Build a regex that replaces known asset URLs
  let result = css;
  for (const [originalUrl, localPath] of assetMap.entries()) {
    // Compute relative path from the CSS file's directory to the asset
    const cssDir = path.dirname(cssLocalPath);
    const relPath = path.relative(cssDir, localPath).replace(/\\/g, "/");
    // Replace in url() references (various quote styles)
    result = result.split(`url('${originalUrl}')`).join(`url('${relPath}')`);
    result = result.split(`url("${originalUrl}")`).join(`url("${relPath}")`);
    result = result.split(`url(${originalUrl})`).join(`url(${relPath})`);
    // Replace @import references
    result = result.split(`@import '${originalUrl}'`).join(`@import '${relPath}'`);
    result = result.split(`@import "${originalUrl}"`).join(`@import "${relPath}"`);
  }
  return result;
}

/**
 * Given two local paths (both relative to an output root), compute the relative
 * path from |fromFile| to |toFile| for use in HTML attributes.
 */
export function computeRelativePath(fromFile: string, toFile: string): string {
  const fromDir = path.dirname(fromFile);
  return path.relative(fromDir, toFile).replace(/\\/g, "/");
}

/**
 * Return a safe filename from a URL, inferring extension if needed.
 */
export function safeFilename(assetUrl: string, contentType?: string): string {
  const parsed = new URL(assetUrl);
  let filePath = sanitizePath(parsed.pathname);
  if (!path.extname(filePath)) {
    // Try to infer extension from Content-Type
    if (contentType) {
      const mime = contentType.split(";")[0]?.trim();
      const extMap: Record<string, string> = {
        "text/css": ".css",
        "text/javascript": ".js",
        "application/javascript": ".js",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/webp": ".webp",
        "image/x-icon": ".ico",
        "font/woff": ".woff",
        "font/woff2": ".woff2",
        "application/font-woff": ".woff",
        "application/font-woff2": ".woff2",
      };
      if (mime && extMap[mime]) {
        filePath += extMap[mime];
      }
    }
  }
  return filePath;
}
