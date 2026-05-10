/**
 * Unified asset discovery from HTML and CSS.
 * Used by both static and dynamic scrapers.
 */

import * as cheerio from "cheerio";
import * as path from "path";
import { URL } from "url";
import {
  resolveUrl,
  sanitizePath,
  parseSrcset,
  extractCssUrls,
} from "./utils.js";
import { USER_AGENT, fetchWithTimeout } from "./config.js";

export interface AssetEntry {
  /** The original href/src from the HTML */
  originalHref: string;
  /** The resolved absolute URL to download from */
  assetUrl: string;
}

export interface AssetCollectorResult {
  /** Map from resolved URL → local relative path */
  assetMap: Map<string, string>;
  /** Queue of assets to download */
  downloadQueue: AssetEntry[];
}

/**
 * If the href/src is a Next.js image optimisation URL
 * (/_next/image?url=<encoded>&w=...&q=...) decode the `url` parameter and
 * return the decoded original URL so we can download the real image.
 */
function resolveNextImageUrl(base: string, href: string): string | null {
  const resolved = resolveUrl(base, href);
  if (!resolved) return null;
  try {
    const u = new URL(resolved);
    if (u.pathname === "/_next/image") {
      const originalUrl = u.searchParams.get("url");
      if (originalUrl) {
        return resolveUrl(base, originalUrl);
      }
    }
  } catch {
    // not a URL we can parse
  }
  return resolved;
}

/**
 * Collect all asset references from a parsed HTML document.
 */
export function collectHtmlAssets(
  $: ReturnType<typeof cheerio.load>,
  pageUrl: string
): AssetCollectorResult {
  const assetMap = new Map<string, string>();
  const downloadQueue: AssetEntry[] = [];
  const visited = new Set<string>();

  function queueAsset(
    originalHref: string,
    opts: { nextImage?: boolean } = {}
  ): string | null {
    const realUrl = opts.nextImage
      ? resolveNextImageUrl(pageUrl, originalHref)
      : resolveUrl(pageUrl, originalHref);
    if (!realUrl) return null;

    const mapKey = resolveUrl(pageUrl, originalHref)!;

    if (visited.has(realUrl)) {
      const existing = assetMap.get(realUrl);
      if (existing && mapKey !== realUrl) assetMap.set(mapKey, existing);
      return assetMap.get(realUrl) ?? null;
    }
    visited.add(realUrl);

    const parsed = new URL(realUrl);
    const rawPath = sanitizePath(parsed.pathname);
    const localPath = path.join(parsed.hostname, rawPath === "/" ? "index.html" : rawPath);
    assetMap.set(realUrl, localPath);
    if (mapKey !== realUrl) assetMap.set(mapKey, localPath);
    downloadQueue.push({ originalHref, assetUrl: realUrl });
    return localPath;
  }

  // CSS stylesheets
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) queueAsset(href);
  });

  // Favicon & other link resources
  $("link[href]").each((_, el) => {
    const rel = $(el).attr("rel") ?? "";
    if (!rel.includes("stylesheet")) {
      const href = $(el).attr("href");
      if (href) queueAsset(href);
    }
  });

  // Scripts (external src)
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) queueAsset(src);
  });

  // Images: src — detect Next.js image optimisation
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    const isNextImage = src.includes("/_next/image") && src.includes("url=");
    queueAsset(src, { nextImage: isNextImage });
  });

  // Images: srcset
  $("[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset") ?? "";
    parseSrcset(srcset).forEach((u) => {
      const isNextImage = u.includes("/_next/image") && u.includes("url=");
      queueAsset(u, { nextImage: isNextImage });
    });
  });

  // <source> elements (picture/video)
  $("source").each((_, el) => {
    const src = $(el).attr("src");
    const srcset = $(el).attr("srcset") ?? "";
    if (src) queueAsset(src);
    parseSrcset(srcset).forEach((u) => queueAsset(u));
  });

  // Video poster attribute
  $("video[poster]").each((_, el) => {
    const poster = $(el).attr("poster");
    if (poster) queueAsset(poster);
  });

  // Object data attribute
  $("object[data]").each((_, el) => {
    const data = $(el).attr("data");
    if (data) queueAsset(data);
  });

  // Embed src attribute
  $("embed[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) queueAsset(src);
  });

  // SVG image elements
  $("image[href], image[xlink\\:href]").each((_, el) => {
    const href = $(el).attr("href") ?? $(el).attr("xlink:href");
    if (href) queueAsset(href);
  });

  // Open Graph / meta images
  $(
    'meta[property="og:image"], meta[name="twitter:image"], ' +
    'meta[name="msapplication-TileImage"]'
  ).each((_, el) => {
    const content = $(el).attr("content");
    if (content) queueAsset(content);
  });

  // Inline style attributes: background-image: url(...)
  $("[style]").each((_, el) => {
    const style = $(el).attr("style") ?? "";
    extractCssUrls(style).forEach((u) => queueAsset(u));
  });

  // data-src / data-srcset (lazy-loaded images)
  $("[data-src]").each((_, el) => {
    const src = $(el).attr("data-src") ?? "";
    queueAsset(src);
  });
  $("[data-srcset]").each((_, el) => {
    const srcset = $(el).attr("data-srcset") ?? "";
    parseSrcset(srcset).forEach((u) => queueAsset(u));
  });

  return { assetMap, downloadQueue };
}

/**
 * Fetch and extract Next.js build manifest chunks, adding them to the queue.
 */
export async function collectNextJsChunks(
  $: ReturnType<typeof cheerio.load>,
  pageUrl: string,
  result: AssetCollectorResult
): Promise<void> {
  const { assetMap, downloadQueue } = result;
  const visited = new Set<string>(downloadQueue.map((e) => e.assetUrl));

  function queueAsset(href: string): void {
    const realUrl = resolveUrl(pageUrl, href);
    if (!realUrl || visited.has(realUrl)) return;
    visited.add(realUrl);
    const parsed = new URL(realUrl);
    const rawPath = sanitizePath(parsed.pathname);
    const localPath = path.join(parsed.hostname, rawPath === "/" ? "index.html" : rawPath);
    assetMap.set(realUrl, localPath);
    downloadQueue.push({ originalHref: href, assetUrl: realUrl });
  }

  const nextDataEl = $("script#__NEXT_DATA__");
  if (!nextDataEl.length) return;

  try {
    const nextData = JSON.parse(nextDataEl.html() ?? "{}");
    const buildId: string = nextData.buildId ?? "";
    if (!buildId) return;

    const manifestUrl = resolveUrl(pageUrl, `/_next/static/${buildId}/_buildManifest.js`);
    const ssrManifestUrl = resolveUrl(pageUrl, `/_next/static/${buildId}/_ssgManifest.js`);
    if (manifestUrl) queueAsset(manifestUrl);
    if (ssrManifestUrl) queueAsset(ssrManifestUrl);

    // Fetch the manifest and extract all chunk URLs
    try {
      const res = await fetchWithTimeout(manifestUrl!, { "User-Agent": USER_AGENT }, 10000);
      const manifestText = await res.text();
      const chunkRe = /\"(\/_next\/static\/(?:chunks|pages|app)[^\"]*.js)\"/g;
      let m;
      while ((m = chunkRe.exec(manifestText)) !== null) {
        const captured = m[1];
        if (!captured) continue;
        const chunkUrl = resolveUrl(pageUrl, captured);
        if (chunkUrl) queueAsset(chunkUrl);
      }
    } catch {
      /* manifest may not exist */
    }
  } catch {
    /* __NEXT_DATA__ parse failed */
  }
}
