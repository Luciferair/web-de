/**
 * Unified asset download engine with concurrency control.
 *
 * Downloads all page assets (CSS, JS, images, fonts) and 3D binary assets
 * (GLTF, HDR, WASM, Draco) locally. Also rewrites URL strings inside
 * JS bundles so Three.js loaders can find local assets.
 *
 * Used by both static and dynamic scrapers.
 */

import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import {
  resolveUrl,
  sanitizePath,
  ensureDir,
  extractCssUrls,
  rewriteCssUrls,
  safeFilename,
} from "./utils.js";
import {
  USER_AGENT,
  ASSET_TIMEOUT,
  DEFAULT_CONCURRENCY,
  fetchWithTimeout,
} from "./config.js";
import type { AssetEntry } from "./asset-collector.js";
import { rewriteUrlsInJsBundle } from "./threejs-cloner.js";

// ── Binary 3D file types ─────────────────────────────────────────────────────

export const BINARY_3D_EXTENSIONS = new Set([
  ".glb", ".gltf", ".hdr", ".exr",
  ".basis", ".ktx2", ".ktx",
  ".wasm", ".bin", ".draco",
  ".dds", ".pvr",
  ".obj", ".mtl", ".fbx",
  ".vert", ".frag", ".glsl",
]);

function is3dAsset(url: string): boolean {
  try {
    const ext = path.extname(new URL(url).pathname.split("?")[0] ?? "").toLowerCase();
    return BINARY_3D_EXTENSIONS.has(ext);
  } catch { return false; }
}

// ── CDN local download directory ─────────────────────────────────────────────

const CDN_LOCAL_DIR = "assets/cdn";

// ── Download via fetch ───────────────────────────────────────────────────────

interface CssFileEntry {
  localPath: string;
  absoluteLocalPath: string;
  assetUrl: string;
}

/**
 * Download a single asset using native fetch.
 * Returns the buffer and content-type, or null on failure.
 */
async function downloadViaFetch(
  assetUrl: string
): Promise<{ data: Buffer; contentType: string } | null> {
  try {
    const res = await fetchWithTimeout(assetUrl, { "User-Agent": USER_AGENT }, ASSET_TIMEOUT);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? "";
    return { data: buf, contentType: ct };
  } catch {
    return null;
  }
}

// ── Process a downloaded asset ───────────────────────────────────────────────

function processDownloadedAsset(
  assetUrl: string,
  data: Buffer,
  contentType: string,
  localRelPath: string,
  outputDir: string,
  assetMap: Map<string, string>,
  additionalUrls: Set<string>,
  cssFiles: CssFileEntry[],
  jsBundlesForRewrite: Array<{ absPath: string; localRelPath: string }>
): void {
  const absPath = path.join(outputDir, localRelPath);
  const isCss = contentType.includes("text/css") || assetUrl.endsWith(".css");
  const isJs  = contentType.includes("javascript") ||
                assetUrl.endsWith(".js") ||
                assetUrl.endsWith(".mjs");

  if (isCss) {
    const cssText = data.toString("utf-8");
    // Extract sub-assets from CSS (fonts, images referenced by url())
    const cssUrls = extractCssUrls(cssText);
    for (const u of cssUrls) {
      const resolved = resolveUrl(assetUrl, u);
      if (resolved && !assetMap.has(resolved)) {
        additionalUrls.add(resolved);
      }
    }
    const filePath = absPath.endsWith(".css") ? absPath : absPath + ".css";
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, cssText, "utf-8");
    cssFiles.push({ localPath: localRelPath, absoluteLocalPath: filePath, assetUrl });
    console.log(`  ✅ CSS  ${localRelPath}`);
  } else if (isJs) {
    ensureDir(path.dirname(absPath));
    // Write first, then queue for URL rewriting after all assets are mapped
    fs.writeFileSync(absPath, data);
    jsBundlesForRewrite.push({ absPath, localRelPath });
    console.log(`  ✅ JS   ${localRelPath}`);
  } else {
    const ext = path.extname(localRelPath);
    const finalPath = ext
      ? absPath
      : absPath + (safeFilename(assetUrl, contentType).match(/\.[^.]+$/) ?? [".bin"])[0];
    ensureDir(path.dirname(finalPath));
    fs.writeFileSync(finalPath, data);
    if (is3dAsset(assetUrl)) {
      console.log(`  ✅ 3D   ${path.relative(outputDir, finalPath)}`);
    } else {
      console.log(`  ✅ Asset ${path.relative(outputDir, finalPath)}`);
    }
  }
}

// ── Download CDN files locally ───────────────────────────────────────────────

/**
 * Download animation framework CDN files into ./assets/cdn/
 * so the cloned site works offline.
 */
export async function downloadCdnAssetsLocally(
  cdnUrls: Array<{ url: string; localName: string }>,
  outputDir: string,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<void> {
  if (cdnUrls.length === 0) return;

  const cdnDir = path.join(outputDir, CDN_LOCAL_DIR);
  ensureDir(cdnDir);

  console.log(`\n📦 Downloading ${cdnUrls.length} CDN assets locally...`);

  async function downloadOne(entry: { url: string; localName: string }): Promise<void> {
    const localPath = path.join(cdnDir, entry.localName);
    if (fs.existsSync(localPath)) return; // already downloaded

    const result = await downloadViaFetch(entry.url);
    if (!result) {
      console.warn(`  ⚠️  CDN download failed: ${entry.url}`);
      return;
    }
    fs.writeFileSync(localPath, result.data);
    console.log(`  ✅ CDN  ${entry.localName}`);
  }

  for (let i = 0; i < cdnUrls.length; i += concurrency) {
    const batch = cdnUrls.slice(i, i + concurrency);
    await Promise.all(batch.map(downloadOne));
  }
}

// ── Main download function ───────────────────────────────────────────────────

interface DownloadResult {
  cssFiles: CssFileEntry[];
}

/**
 * Download all assets in the queue with concurrency control.
 * Discovers and downloads CSS/3D sub-assets recursively.
 * Rewrites URL strings inside JS bundles after all assets are mapped.
 */
export async function downloadAllAssets(
  downloadQueue: AssetEntry[],
  assetMap: Map<string, string>,
  outputDir: string,
  _browserContext?: unknown,
  concurrency: number = DEFAULT_CONCURRENCY,
  baseDomain?: string
): Promise<DownloadResult> {
  const cssFiles: CssFileEntry[] = [];
  const additionalUrls = new Set<string>();
  const downloaded = new Set<string>();
  const jsBundlesForRewrite: Array<{ absPath: string; localRelPath: string }> = [];

  console.log(`\n📦 Downloading ${downloadQueue.length} assets (concurrency: ${concurrency})...`);

  const allUrls = downloadQueue.map((e) => e.assetUrl);

  async function downloadOne(assetUrl: string): Promise<void> {
    if (downloaded.has(assetUrl)) return;
    if (assetUrl.startsWith("data:") || assetUrl.startsWith("blob:")) return;
    downloaded.add(assetUrl);

    const localRelPath = assetMap.get(assetUrl);
    if (!localRelPath) return;

    const absPath = path.join(outputDir, localRelPath);
    ensureDir(path.dirname(absPath));

    // Skip if already downloaded (except JS bundles that need rewriting)
    if (fs.existsSync(absPath) && !assetUrl.endsWith(".js")) return;

    const result = await downloadViaFetch(assetUrl);
    if (!result) {
      console.warn(`  ⚠️  Failed: ${assetUrl}`);
      return;
    }

    processDownloadedAsset(
      assetUrl,
      result.data,
      result.contentType,
      localRelPath,
      outputDir,
      assetMap,
      additionalUrls,
      cssFiles,
      jsBundlesForRewrite
    );
  }

  // Download in batches
  for (let i = 0; i < allUrls.length; i += concurrency) {
    const batch = allUrls.slice(i, i + concurrency);
    await Promise.all(batch.map(downloadOne));
  }

  // Download CSS sub-assets discovered during first pass
  if (additionalUrls.size > 0) {
    console.log(`  📎 Downloading ${additionalUrls.size} CSS sub-assets...`);
    const subUrls: string[] = [];
    for (const subUrl of additionalUrls) {
      if (!assetMap.has(subUrl) && !downloaded.has(subUrl)) {
        try {
          const parsed = new URL(subUrl);
          const rawPath = sanitizePath(parsed.pathname + (parsed.search || ""));
          const hostname = baseDomain ?? parsed.hostname;
          const localPath = path.join(hostname, rawPath === "/" ? "index.html" : rawPath);
          assetMap.set(subUrl, localPath);
          subUrls.push(subUrl);
        } catch { continue; }
      }
    }
    for (let i = 0; i < subUrls.length; i += concurrency) {
      const batch = subUrls.slice(i, i + concurrency);
      await Promise.all(batch.map(downloadOne));
    }
  }

  // Rewrite CSS files with local paths
  for (const { localPath, absoluteLocalPath } of cssFiles) {
    if (!fs.existsSync(absoluteLocalPath)) continue;
    const cssText = fs.readFileSync(absoluteLocalPath, "utf-8");
    const rewritten = rewriteCssUrls(cssText, assetMap, localPath);
    fs.writeFileSync(absoluteLocalPath, rewritten, "utf-8");
  }

  // Rewrite URL strings in JS bundles (for Three.js loaders)
  if (jsBundlesForRewrite.length > 0) {
    console.log(`\n🔗 Rewriting URLs in ${jsBundlesForRewrite.length} JS bundle(s)...`);
    for (const { absPath, localRelPath } of jsBundlesForRewrite) {
      if (!fs.existsSync(absPath)) continue;
      try {
        let jsContent = fs.readFileSync(absPath, "utf-8");
        const rewritten = rewriteUrlsInJsBundle(jsContent, assetMap, localRelPath);
        if (rewritten !== jsContent) {
          fs.writeFileSync(absPath, rewritten, "utf-8");
          console.log(`  ✅ Rewrote URLs in ${localRelPath}`);
        }
      } catch (err) {
        console.warn(`  ⚠️  JS rewrite failed for ${localRelPath}: ${err}`);
      }
    }
  }

  return { cssFiles };
}
