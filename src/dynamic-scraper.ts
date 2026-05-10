/**
 * Dynamic scraper: uses puppeteer-core headless browser to render JS-heavy pages,
 * captures the fully-rendered DOM with ALL animations in their live/interactive state,
 * downloads all assets (including 3D binary files), and saves a self-contained clone.
 *
 * Works universally for ANY website regardless of framework.
 *
 * Strategy: Preserve & Replay > Freeze & Screenshot
 *   - Scripts stay alive (original JS bundles downloaded locally)
 *   - Canvas elements never replaced with images
 *   - Fetch/XHR intercepted for 3D asset URL capture
 *   - Live getComputedStyle CSS var harvest (dark + light)
 *   - GSAP/Framer elements tagged with data-scraper-* for offline replay
 */

import type { Browser, Page } from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { URL } from "url";
import {
  resolveUrl,
  sanitizePath,
  ensureDir,
  parseSrcset,
} from "./utils.js";
import {
  type DynamicScrapeOptions,
  type LoginOptions,
  type Cookie,
} from "./config.js";
import { downloadAllAssets, downloadCdnAssetsLocally } from "./asset-downloader.js";
import { postProcessHtml } from "./shared.js";
import {
  injectPreservedAnimations,
  EXTRACT_CSS_SCRIPT,
} from "./animation-capture.js";
import { launchStealthBrowser, applyStealthToPage } from "./stealth.js";
import { detectBotProtectionFromHtml } from "./challenge-detector.js";
import { injectStaticEnhancement } from "./static-enhance.js";
import type { CssVarHarvest } from "./static-enhance.js";
import {
  DETECT_AND_FREEZE_SCRIPT,
  PAGE_INIT_SCRIPT,
  HARVEST_CSS_VARS_SCRIPT,
} from "./animation-engine.js";
import {
  detectFrameworksFromHtml,
  injectCdnFrameworks,
  injectFramerMotionCssFallback,
  injectSvelteTransitionReplay,
  collectCdnDownloadUrls,
} from "./cdn-injector.js";
import {
  THREE_NETWORK_INTERCEPT_SCRIPT,
  COLLECT_THREE_ASSETS_SCRIPT,
  DETECT_THREE_INFO_SCRIPT,
  preserveCanvasElements,
  injectThreeCdnScripts,
  generateServeScript,
  injectWasmPathOverride,
  getThreeCdnAssets,
} from "./threejs-cloner.js";

export type { LoginOptions, Cookie, DynamicScrapeOptions };

// ── Binary asset extensions to intercept ─────────────────────────────────────

const BINARY_EXTENSIONS_PATTERN = /\.(glb|gltf|hdr|exr|basis|ktx2?|wasm|bin|draco|dds|pvr|obj|fbx|mtl|vert|frag|glsl)(\?|$)/i;

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrapeDynamic(options: DynamicScrapeOptions): Promise<void> {
  const {
    url: pageUrl,
    outputDir,
    cookiesFile,
    loginOptions,
    manualLogin = false,
    extraWaitMs = 3000,
  } = options;

  ensureDir(outputDir);

  // ── Launch browser ─────────────────────────────────────────────────────────
  const headless = !manualLogin;
  const stealthConfig = options.stealth ?? { enabled: false };
  console.log(`\n🚀 [DYNAMIC] Launching ${headless ? "headless" : "visible"} browser${stealthConfig.enabled ? " (stealth)" : ""}...`);

  const browser: Browser = await launchStealthBrowser(headless, stealthConfig);
  const page: Page = await browser.newPage();

  // Apply stealth/user-agent settings
  await applyStealthToPage(page, stealthConfig);

  // ── Pre-navigation scripts ──────────────────────────────────────────────────
  // Inject analytics stubbing + fetch/XHR intercept for 3D asset capture
  await page.evaluateOnNewDocument(PAGE_INIT_SCRIPT + "\n" + THREE_NETWORK_INTERCEPT_SCRIPT);

  // ── Inject cookies ─────────────────────────────────────────────────────────
  if (cookiesFile) {
    console.log(`🍪 Loading cookies from: ${cookiesFile}`);
    const raw = fs.readFileSync(cookiesFile, "utf-8");
    const cookies: Cookie[] = JSON.parse(raw);
    await page.setCookie(...cookies);
    console.log(`   Injected ${cookies.length} cookie(s)`);
  }

  // ── Automated login ────────────────────────────────────────────────────────
  if (loginOptions) {
    console.log(`\n🔐 Logging in at: ${loginOptions.url}`);
    await page.goto(loginOptions.url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.type(loginOptions.userField, loginOptions.user);
    await page.type(loginOptions.passField, loginOptions.pass);
    await page.click(loginOptions.submitBtn);
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 60000 });
    console.log(`   ✅ Login complete`);
  }

  // ── Manual login pause ─────────────────────────────────────────────────────
  if (manualLogin) {
    console.log(`\n🖱️  Browser window is open. Log in manually, then press ENTER...`);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });
  }

  // ── Intercept ALL network requests ────────────────────────────────────────
  const interceptedAssets = new Set<string>();
  page.on("request", (req) => {
    const url = req.url();
    const rt = req.resourceType();
    // Standard web assets
    if (["stylesheet", "script", "image", "font", "media", "other"].includes(rt)) {
      interceptedAssets.add(url);
    }
    // 3D binary assets (via fetch/xhr resource types)
    if (rt === "fetch" || rt === "xhr" || BINARY_EXTENSIONS_PATTERN.test(url)) {
      interceptedAssets.add(url);
    }
  });

  // ── Navigate to target page ────────────────────────────────────────────────
  console.log(`\n🌐 Navigating to: ${pageUrl}`);

  try {
    await page.goto(pageUrl, {
      waitUntil: "networkidle2",
      timeout: options.timeout ?? 90000,
    });
  } catch (navErr) {
    const isTimeout = (navErr instanceof Error) && navErr.message.includes("timeout");
    if (isTimeout) {
      console.warn("   ⚠️  networkidle timeout — continuing with domcontentloaded state");
      try {
        await page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      } catch { /* proceed with whatever loaded */ }
    } else {
      throw navErr;
    }
  }

  // ── Bot protection check ────────────────────────────────────────────────────
  const initialHtml = await page.content();
  const protection = detectBotProtectionFromHtml(initialHtml, 200);
  if (protection) {
    console.log(`  🛡️  Bot protection detected: ${protection}`);
    if (protection === "cloudflare") {
      console.log("  ⏳ Waiting for Cloudflare challenge to auto-resolve...");
      await page
        .waitForFunction(
          () => !document.body.innerText.includes("Just a moment..."),
          { timeout: 30000 }
        )
        .catch(() => console.warn("  ⚠️  Cloudflare challenge may not have resolved"));
    }
  }

  // ── Phase 0: Initial JS settle ─────────────────────────────────────────────
  const settleMs = Math.max(extraWaitMs, 2500);
  console.log(`   ⏳ Waiting ${settleMs}ms for JS frameworks to initialize...`);
  await sleep(settleMs);

  // ── Detect animation libraries ─────────────────────────────────────────────
  const detectedLibs = await page.evaluate(() => {
    return {
      framerMotion: !!(
        (window as any).__framer_metadata ||
        (window as any).FramerMotion ||
        document.querySelector("[data-framer-appear-id]") ||
        document.querySelector("[data-projection-id]")
      ),
      gsap: !!(
        (window as any).gsap ||
        (window as any).GreenSockGlobals ||
        (window as any).TweenMax
      ),
      aos: !!(
        (window as any).AOS ||
        document.querySelector("[data-aos]")
      ),
      lottie: !!(
        (window as any).lottie ||
        (window as any).bodymovin ||
        document.querySelector("lottie-player")
      ),
      particles: !!(
        (window as any).particlesJS ||
        (window as any).tsParticles ||
        document.querySelector("#particles-js")
      ),
      three: !!(window as any).THREE,
      typed: !!(
        (window as any).Typed ||
        document.querySelector(".typed-cursor")
      ),
      gsapScrollTrigger: !!(window as any).ScrollTrigger,
      svelte: !!document.querySelector('[class*="svelte-"]'),
    };
  });

  const libsList = (Object.entries(detectedLibs) as [string, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k);

  if (libsList.length > 0) {
    console.log(`   📚 Detected libraries: ${libsList.join(", ")}`);
  }

  // ── Detect Three.js scene info ─────────────────────────────────────────────
  let threeInfo = { revision: null as string | null, canvasCount: 0, hasWebGPU: false, hasPhysics: false, hasPostProcessing: false, hasWebGL2: false, rendererType: null as string | null };
  if (detectedLibs.three) {
    try {
      const raw = await page.evaluate(DETECT_THREE_INFO_SCRIPT) as string;
      threeInfo = { ...threeInfo, ...JSON.parse(raw) };
      console.log(`   🎮 Three.js r${threeInfo.revision ?? "?"} detected (${threeInfo.canvasCount} canvas, WebGPU: ${threeInfo.hasWebGPU})`);
    } catch { /* */ }
  }

  // ── Phase 1: Trigger interactive elements ─────────────────────────────────
  if (options.interact) {
    console.log(`   🖱️  Triggering interactive elements...`);
    await triggerInteractiveElements(page);
  }

  // ── Phase 2: Comprehensive scroll (vertical + horizontal) ─────────────────
  console.log(`   🎬 Triggering scroll-based animations...`);
  await triggerScrollAnimations(page, options.maxScrollPasses ?? 3, detectedLibs.gsap);

  // ── Wait for animation enter transitions to complete ──────────────────────
  const animWait = Math.max(extraWaitMs, 2500);
  console.log(`   ⏳ Waiting ${animWait}ms for animations to complete...`);
  await sleep(animWait);

  // ── Phase 3: GSAP fast-forward ───────────────────────────────────────────
  if (detectedLibs.gsap) {
    console.log(`   ⚡ Fast-forwarding GSAP timelines...`);
    await page.evaluate(() => {
      try {
        if ((window as any).gsap) {
          (window as any).gsap.globalTimeline.progress(1, false);
        }
        if ((window as any).ScrollTrigger) {
          (window as any).ScrollTrigger.getAll().forEach((t: any) => {
            try { t.progress(1, false); } catch { /* */ }
          });
        }
        if ((window as any).TweenMax) {
          (window as any).TweenMax.pauseAll(false, false);
        }
      } catch { /* */ }
    });
    await sleep(500);
  }

  // ── Phase 4: Wait for canvas paint (Three.js) ────────────────────────────
  if (detectedLibs.three && (options as any).waitForCanvas) {
    console.log(`   🎮 Waiting for Three.js canvas to paint...`);
    await waitForCanvasPaint(page);
  }

  // ── Phase 5: Freeze animation states + tag elements ──────────────────────
  console.log(`   🎯 Freezing animation states & tagging elements...`);
  let detectedByEngine: Record<string, boolean> = {};
  try {
    const engineResult = await page.evaluate(DETECT_AND_FREEZE_SCRIPT) as string;
    detectedByEngine = JSON.parse(engineResult);
  } catch (err) {
    console.warn(`   ⚠️  Animation engine warning: ${err instanceof Error ? err.message : err}`);
  }

  // ── Phase 6: Harvest CSS variables from live DOM ──────────────────────────
  console.log(`   🎨 Harvesting CSS variables from live DOM (dark + light pass)...`);
  let cssVarHarvest: CssVarHarvest | undefined;
  try {
    const rawVars = await page.evaluate(HARVEST_CSS_VARS_SCRIPT) as string;
    cssVarHarvest = JSON.parse(rawVars) as CssVarHarvest;
    const rootCount = Object.keys(cssVarHarvest.root).length;
    const darkCount = Object.keys(cssVarHarvest.dark).length;
    console.log(`   ✅ Harvested ${rootCount} root/light vars, ${darkCount} dark vars`);

    // Sanity check: if root and dark vars are identical, the two-pass
    // may have not worked (single-theme site). Log a warning.
    if (rootCount > 0 && darkCount > 0) {
      const rootBg = cssVarHarvest.root['--background'] ?? cssVarHarvest.root['--bg'] ?? '';
      const darkBg = cssVarHarvest.dark['--background'] ?? cssVarHarvest.dark['--bg'] ?? '';
      if (rootBg && darkBg && rootBg === darkBg) {
        console.warn(`   ⚠️  Root and dark --background vars are identical (${rootBg}) — site may use single theme or oklch() values`);
      }
    }
  } catch (err) {
    console.warn(`   ⚠️  CSS var harvest failed: ${err instanceof Error ? err.message : err}`);
  }

  // ── Phase 7: Extract CSS animations ──────────────────────────────────────
  console.log(`   🎨 Extracting CSS animations (including cross-origin)...`);
  let extractedCSS = "";
  try {
    // EXTRACT_CSS_SCRIPT now returns a Promise (for cross-origin fetch)
    extractedCSS = await page.evaluate(EXTRACT_CSS_SCRIPT) as string;
    if (!extractedCSS) extractedCSS = "";
    const kfCount = (extractedCSS.match(/@keyframes/g) ?? []).length;
    console.log(`   ✅ Extracted ${kfCount} @keyframes`);
  } catch (err) {
    console.warn(`   ⚠️  CSS extraction warning: ${err instanceof Error ? err.message : err}`);
  }

  // ── Phase 8: Collect Three.js asset URLs ─────────────────────────────────
  const threeAssetUrls: string[] = [];
  if (detectedLibs.three) {
    try {
      const raw = await page.evaluate(COLLECT_THREE_ASSETS_SCRIPT) as string;
      const urls = JSON.parse(raw) as string[];
      threeAssetUrls.push(...urls);
      if (urls.length > 0) {
        console.log(`   🎮 Captured ${urls.length} Three.js asset URL(s)`);
      }
    } catch { /* */ }
  }

  // ── Phase 9: Canvas and Lottie capture ───────────────────────────────────
  if (options.captureCanvas && !detectedLibs.three) {
    // Only replace canvas with image for NON-Three.js, NON-hero-background canvases
    // Hero section canvases (absolute inset-0) are managed by our canvas animation script
    console.log(`   🖼️  Capturing canvas elements as images...`);
    await captureCanvasElements(page);
  }

  if (detectedLibs.lottie) {
    console.log(`   🎞️  Capturing Lottie animations...`);
    await captureLottieAnimations(page);
  }

  // ── Phase 10: Scroll back to top ────────────────────────────────────────
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);

  // ── Capture final rendered HTML ────────────────────────────────────────────
  const renderedHtml = await page.content();
  const actualPageUrl = page.url();
  console.log(`   ✅ Page captured (${renderedHtml.length.toLocaleString()} bytes)`);

  await browser.close();

  // ── Parse rendered HTML ────────────────────────────────────────────────────
  const $ = cheerio.load(renderedHtml);

  const baseDomain = new URL(actualPageUrl).hostname;
  const assetMap = new Map<string, string>();
  const allAssetUrls = new Set<string>();
  const nextImageMap = new Map<string, string>();

  interceptedAssets.forEach((u) => allAssetUrls.add(u));
  // Add Three.js intercepted assets
  threeAssetUrls.forEach((u) => allAssetUrls.add(u));

  function resolveAssetUrl(href: string): string | null {
    const resolved = resolveUrl(pageUrl, href);
    if (!resolved) return null;
    try {
      const u = new URL(resolved);
      if (u.pathname === "/_next/image") {
        const originalUrl = u.searchParams.get("url");
        if (originalUrl) {
          const realUrl = resolveUrl(pageUrl, originalUrl);
          if (realUrl) {
            nextImageMap.set(resolved, realUrl);
            return realUrl;
          }
        }
      }
    } catch { /* */ }
    return resolved;
  }

  // ── Collect all asset URLs from DOM ───────────────────────────────────────
  $("link[href], script[src], img[src], source[src], video[poster], video[src], audio[src], object[data], embed[src]").each((_, el) => {
    const tag = $(el).prop("tagName")?.toLowerCase() ?? "";
    let attr: string | undefined;
    if (tag === "link") attr = $(el).attr("href");
    else if (tag === "video" || tag === "audio") {
      attr = $(el).attr("src") || $(el).attr("poster");
    }
    else if (tag === "object") attr = $(el).attr("data");
    else attr = $(el).attr("src");
    if (attr) {
      const r = resolveAssetUrl(attr);
      if (r) allAssetUrls.add(r);
    }
  });

  // SVG use / image elements
  $("image[href], image[xlink\\:href], use[href], use[xlink\\:href]").each((_, el) => {
    const href = $(el).attr("href") ?? $(el).attr("xlink:href");
    if (href && !href.startsWith("#")) {
      const r = resolveAssetUrl(href);
      if (r) allAssetUrls.add(r);
    }
  });

  // srcset attributes
  $("[srcset]").each((_, el) => {
    parseSrcset($(el).attr("srcset") ?? "").forEach((u) => {
      const r = resolveAssetUrl(u);
      if (r) allAssetUrls.add(r);
    });
  });

  // Lazy-load data-src attributes
  const lazySrcAttrs = ["data-src", "data-lazy-src", "data-original", "data-url", "data-image"];
  lazySrcAttrs.forEach((attr) => {
    $(`[${attr}]`).each((_, el) => {
      const src = $(el).attr(attr);
      if (src) { const r = resolveAssetUrl(src); if (r) allAssetUrls.add(r); }
    });
  });

  $("[data-srcset]").each((_, el) => {
    parseSrcset($(el).attr("data-srcset") ?? "").forEach((u) => {
      const r = resolveAssetUrl(u);
      if (r) allAssetUrls.add(r);
    });
  });

  // Inline style background-image
  $('[style*="url("]').each((_, el) => {
    const style = $(el).attr("style") ?? "";
    const urlMatches = style.matchAll(/url\(['"']?([^'")\s]+)['"']?\)/g);
    for (const m of urlMatches) {
      const urlVal = m[1];
      if (!urlVal) continue;
      const r = resolveAssetUrl(urlVal);
      if (r) allAssetUrls.add(r);
    }
  });

  // ── Build asset map ────────────────────────────────────────────────────────
  const downloadQueue: Array<{ originalHref: string; assetUrl: string }> = [];

  for (const assetUrl of allAssetUrls) {
    if (assetUrl.startsWith("data:") || assetUrl.startsWith("blob:") || assetUrl === pageUrl) continue;
    try {
      const parsed = new URL(assetUrl);
      const pathWithQuery = parsed.pathname + (parsed.search || "");
      const rawPath = sanitizePath(pathWithQuery);
      const hostname = parsed.hostname === new URL(actualPageUrl).hostname ? baseDomain : parsed.hostname;
      const localRelPath = path.join(hostname, rawPath === "/" ? "index.html" : rawPath);
      assetMap.set(assetUrl, localRelPath);
      downloadQueue.push({ originalHref: assetUrl, assetUrl });
    } catch { continue; }
  }

  // Register Next.js image URL mappings
  for (const [nextUrl, realUrl] of nextImageMap) {
    const realPath = assetMap.get(realUrl);
    if (realPath) assetMap.set(nextUrl, realPath);
  }

  // ── Download all assets ───────────────────────────────────────────────────
  await downloadAllAssets(
    downloadQueue,
    assetMap,
    outputDir,
    undefined,
    options.concurrency,
    baseDomain
  );

  // ── Detect animation frameworks from captured HTML ────────────────────────
  console.log(`   🔍 Detecting animation frameworks...`);
  const detectedFrameworks = detectFrameworksFromHtml($);

  // ── Download CDN assets locally ───────────────────────────────────────────
  const cdnUrls = collectCdnDownloadUrls(detectedFrameworks);

  // Add Three.js CDN assets if detected
  if (detectedLibs.three) {
    const threeCdnAssets = getThreeCdnAssets(threeInfo.revision);
    for (const asset of threeCdnAssets) {
      cdnUrls.push({ url: asset.url, localName: asset.localName });
    }
  }

  if (cdnUrls.length > 0) {
    await downloadCdnAssetsLocally(cdnUrls, outputDir, options.concurrency);
  }

  // ── Collect CSS texts for theme detection ─────────────────────────────────
  const cssTexts: string[] = [];
  for (const [, localPath] of assetMap.entries()) {
    if (localPath.endsWith(".css")) {
      const absPath = path.join(outputDir, localPath);
      if (fs.existsSync(absPath)) cssTexts.push(fs.readFileSync(absPath, "utf-8"));
    }
  }

  // ── Inject preserved CSS animations ──────────────────────────────────────
  if (extractedCSS) {
    injectPreservedAnimations($, extractedCSS);
    const kfCount = (extractedCSS.match(/@keyframes/g) ?? []).length;
    const propCount = (extractedCSS.match(/@property/g) ?? []).length;
    console.log(`🎬 Preserved ${kfCount} @keyframes, ${propCount} @property rules`);
  }

  // ── Canvas preservation for Three.js sites ───────────────────────────────
  if (detectedLibs.three) {
    preserveCanvasElements($, threeInfo);
    injectThreeCdnScripts($, threeInfo.revision);
    injectWasmPathOverride($, assetMap);
    generateServeScript(outputDir);
    console.log(`   🎮 Three.js canvas preserved (live 3D scene)`);
  }

  // ── Post-process HTML: rewrite asset URLs ─────────────────────────────────
  postProcessHtml($, pageUrl, assetMap, "index.html", cssTexts);

  // ── Inject CDN framework scripts (local copies) ───────────────────────────
  injectCdnFrameworks($, detectedFrameworks);

  // ── Inject Framer Motion per-element CSS fallback ─────────────────────────
  if (detectedFrameworks.framerMotion) {
    injectFramerMotionCssFallback($);
    console.log(`   🎭 Injected Framer Motion per-element animation fallback`);
  }

  // ── Inject Svelte transition replay ──────────────────────────────────────
  if (detectedFrameworks.svelte) {
    injectSvelteTransitionReplay($);
    console.log(`   ⚡ Injected Svelte transition replay`);
  }

  // ── Inject offline interactivity enhancement ──────────────────────────────
  injectStaticEnhancement($, cssTexts, cssVarHarvest);
  console.log(`🎯 Injected offline enhancement script`);

  // ── Save index.html ───────────────────────────────────────────────────────
  const finalHtml = $.html();
  const outputHtmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(outputHtmlPath, finalHtml, "utf-8");

  console.log(`\n✨ Done! Saved to: ${outputHtmlPath}`);
  if (detectedLibs.three) {
    console.log(`   ⚠️  Three.js site — serve via HTTP:`);
    console.log(`   cd ${outputDir} && bash serve.sh`);
    console.log(`   Or: cd ${outputDir} && npx serve . -p 8080`);
  } else {
    console.log(`   Open in browser: file://${outputHtmlPath.replace(/\\/g, "/")}`);
  }
}

// ── Helper: sleep ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Helper: Trigger interactive elements ─────────────────────────────────────

async function triggerInteractiveElements(page: Page): Promise<void> {
  const triggered = await page.evaluate(() => {
    let count = 0;

    document.querySelectorAll("details:not([open])").forEach((el) => {
      (el as HTMLDetailsElement).open = true;
      count++;
    });

    document.querySelectorAll('[role="tab"]').forEach((el) => {
      (el as HTMLElement).click();
      count++;
    });

    document.querySelectorAll(
      'button[class*="load-more"], button[class*="show-more"], [data-load-more]'
    ).forEach((el) => {
      (el as HTMLElement).click();
      count++;
    });

    document.querySelectorAll('[aria-expanded="false"]').forEach((el) => {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (!/menu|nav|hamburger/.test(label)) {
        (el as HTMLElement).click();
        count++;
      }
    });

    return count;
  });

  if (triggered > 0) {
    console.log(`   ✅ Triggered ${triggered} interactive element(s)`);
    await sleep(800);
  }
}

// ── Helper: Comprehensive scroll animation trigger ────────────────────────────

async function triggerScrollAnimations(
  page: Page,
  passes: number,
  hasGsap: boolean
): Promise<void> {
  await page.evaluate(async (maxPasses: number, _hasGsap: boolean) => {
    function raf(): Promise<void> {
      return new Promise((r) => requestAnimationFrame(() => r()));
    }

    for (let pass = 0; pass < maxPasses; pass++) {
      const pageHeight = document.documentElement.scrollHeight;
      const stepSize = pass === 0
        ? Math.max(100, window.innerHeight / 6)
        : Math.max(200, window.innerHeight / 3);

      // Vertical scroll DOWN
      for (let y = 0; y <= pageHeight; y += stepSize) {
        window.scrollTo({ top: y, behavior: "instant" });
        window.dispatchEvent(new Event("scroll", { bubbles: true }));
        document.dispatchEvent(new Event("scroll", { bubbles: true }));
        await raf();
        await new Promise<void>((r) => setTimeout(r, pass === 0 ? 80 : 40));
      }

      // Horizontal scroll sweep (for horizontal panels)
      document.querySelectorAll('[class*="horizontal"], [class*="h-scroll"], [style*="overflow-x"]').forEach(el => {
        const scrollWidth = el.scrollWidth - el.clientWidth;
        if (scrollWidth > 0) {
          for (let x = 0; x <= scrollWidth; x += 100) {
            (el as HTMLElement).scrollLeft = x;
            el.dispatchEvent(new Event("scroll", { bubbles: true }));
          }
          (el as HTMLElement).scrollLeft = 0;
        }
      });

      // Scroll back to top
      window.scrollTo({ top: 0, behavior: "instant" });
      window.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise<void>((r) => setTimeout(r, 400));
    }

    // Final: bottom then top
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    await new Promise<void>((r) => setTimeout(r, 300));
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise<void>((r) => setTimeout(r, 200));

  }, passes, hasGsap);
}

// ── Helper: Wait for WebGL canvas to paint ───────────────────────────────────

async function waitForCanvasPaint(page: Page, maxWaitMs: number = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const painted = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return false;
      try {
        const ctx = (canvas as HTMLCanvasElement).getContext("webgl2") ||
                    (canvas as HTMLCanvasElement).getContext("webgl");
        if (!ctx) return false;
        const px = new Uint8Array(4);
        (ctx as WebGLRenderingContext).readPixels(
          canvas.width >> 1, canvas.height >> 1, 1, 1,
          (ctx as WebGLRenderingContext).RGBA,
          (ctx as WebGLRenderingContext).UNSIGNED_BYTE,
          px
        );
        return (px[3] ?? 0) > 10; // alpha > 10 means something painted
      } catch { return false; }
    });
    if (painted) {
      console.log(`   ✅ Canvas painted`);
      return;
    }
    await sleep(300);
  }
  console.warn("   ⚠️  Canvas paint timeout — proceeding anyway");
}

// ── Helper: Capture canvas elements as images (non-3D sites only) ─────────────

async function captureCanvasElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("canvas:not([data-scraper-preserve-canvas])").forEach((el) => {
      const canvas = el as HTMLCanvasElement;
      try {
        if (canvas.width === 0 || canvas.height === 0) return;

        // Skip background/hero canvases — these are position:absolute and fill
        // a section element. Our canvas animation script manages them.
        const cs = window.getComputedStyle(canvas);
        if (cs.position === "absolute" || cs.position === "fixed") {
          // Likely a background canvas — mark for animation script and skip
          canvas.setAttribute("data-scraper-canvas-managed", "true");
          return;
        }

        const img = document.createElement("img");
        img.src = (canvas as HTMLCanvasElement).toDataURL("image/png");
        img.style.cssText = (canvas as HTMLCanvasElement).style.cssText;
        img.style.width = cs.width;
        img.style.height = cs.height;
        img.style.position = cs.position;
        img.style.top = cs.top;
        img.style.left = cs.left;
        img.style.zIndex = cs.zIndex;
        img.className = canvas.className;
        img.id = canvas.id ? canvas.id + "-static" : "";
        canvas.parentNode?.replaceChild(img, canvas);
      } catch { /* tainted canvas */ }
    });
  });
}

// ── Helper: Capture Lottie animations ─────────────────────────────────────────

async function captureLottieAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lottieLib = (window as any).lottie || (window as any).bodymovin;
    if (!lottieLib) return;
    try {
      const anims = lottieLib.getRegisteredAnimations?.() ?? [];
      anims.forEach((anim: any) => {
        try {
          anim.goToAndStop(1, true);
          anim.renderer?.renderFrame?.(null);
        } catch { /* */ }
      });
    } catch { /* */ }
  });
}
