/**
 * Static scraper: fetches HTML via native fetch, parses assets with cheerio,
 * downloads all assets, rewrites URLs, saves self-contained output.
 */

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { ensureDir } from "./utils.js";
import { type ScrapeOptions, USER_AGENT, fetchWithTimeout } from "./config.js";
import { collectHtmlAssets, collectNextJsChunks } from "./asset-collector.js";
import { downloadAllAssets } from "./asset-downloader.js";
import { postProcessHtml } from "./shared.js";
import { extractKeyframesFromCSS, injectPreservedAnimations } from "./animation-capture.js";
import { injectStaticEnhancement } from "./static-enhance.js";

/**
 * Static scraper entry point.
 */
export async function scrapeStatic(options: ScrapeOptions): Promise<void> {
  const { url: pageUrl, outputDir, concurrency } = options;
  ensureDir(outputDir);

  console.log(`\n🌐 [STATIC] Fetching: ${pageUrl}`);
  const response = await fetchWithTimeout(pageUrl, { "User-Agent": USER_AGENT }, 30000);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${pageUrl}`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);

  // ── Collect assets from HTML ──────────────────────────────────────────────
  const assetResult = collectHtmlAssets($, pageUrl);

  // ── Next.js: extract ALL JS chunks from _buildManifest ────────────────────
  await collectNextJsChunks($, pageUrl, assetResult);

  // ── Download all assets ───────────────────────────────────────────────────
  await downloadAllAssets(
    assetResult.downloadQueue,
    assetResult.assetMap,
    outputDir,
    undefined,
    concurrency
  );

  // ── Extract and preserve CSS @keyframes animations ─────────────────────
  const cssTexts: string[] = [];
  for (const [, localPath] of assetResult.assetMap.entries()) {
    if (localPath.endsWith(".css")) {
      const absPath = path.join(outputDir, localPath);
      if (fs.existsSync(absPath)) {
        cssTexts.push(fs.readFileSync(absPath, "utf-8"));
      }
    }
  }
  const preservedKeyframes = extractKeyframesFromCSS(cssTexts);
  if (preservedKeyframes) {
    injectPreservedAnimations($, preservedKeyframes);
    console.log(`🎬 Preserved ${preservedKeyframes.split("@keyframes").length - 1} CSS @keyframes animations`);
  }

  // ── Post-process HTML: strip animations, rewrite URLs ─────────────────────
  postProcessHtml($, pageUrl, assetResult.assetMap, "index.html", cssTexts, true);

  // ── Inject generic interactivity enhancement ──────────────────────────────
  injectStaticEnhancement($);
  console.log(`🎯 Injected generic interactivity enhancement script`);

  // ── Save index.html ───────────────────────────────────────────────────────
  const finalHtml = $.html();
  const outputHtmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(outputHtmlPath, finalHtml, "utf-8");
  console.log(`\n✨ Done! Saved to: ${outputHtmlPath}`);
  console.log(`   Open it in your browser: file://${outputHtmlPath.replace(/\\/g, "/")}`);
}
