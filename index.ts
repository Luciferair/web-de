#!/usr/bin/env bun
/**
 * Website Cloner — CLI Entry Point
 *
 * Usage:
 *   bun run index.ts <URL> [output-dir] [options]
 *
 * Auto-detects whether the page needs JavaScript rendering and picks the
 * right mode automatically. Supports bot-protected pages, animations,
 * lazy-loaded images, and interactive elements.
 */

import { scrapeStatic } from "./src/scraper.js";
import { scrapeDynamic } from "./src/dynamic-scraper.js";
import {
  type LoginOptions,
  type DetectionResult,
  USER_AGENT,
  fetchWithTimeout,
} from "./src/config.js";
import { detectBotProtectionFromHtml } from "./src/challenge-detector.js";
import path from "path";

// ── Parse CLI arguments ────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length < 1 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║          Universal Website Cloner — Same-to-Same Clone          ║
╚══════════════════════════════════════════════════════════════════╝

Usage:
  bun run index.ts <URL> [output-dir] [options]

Mode Options:
  --dynamic              Force headless Chromium (JS-rendered / SPA sites)
  --static               Force static mode (fast, no browser)

Authentication:
  --cookies <file.json>  Inject cookies (for protected / authenticated pages)
  --login <json>         Auto-login via form (see below)
  --manual-login         Open visible browser — log in yourself, then press ENTER

Stealth / Bot Protection:
  --stealth              Enable stealth mode (fingerprint spoofing, anti-detection)
  --no-stealth           Disable stealth even if bot protection detected
  --proxy <url>          HTTP/SOCKS5 proxy URL

Page Handling:
  --wait <ms>            Extra wait after page load [default: 3000]
  --interact             Trigger tabs, accordions, "Load More" buttons
  --max-scroll <n>       Maximum scroll passes [default: 3]
  --capture-canvas       Convert canvas elements to static images (non-3D only)
  --concurrency <n>      Parallel asset downloads [default: 5]
  --timeout <ms>         Page load timeout [default: 90000]

3D / WebGL Sites:
  --three                Enable Three.js/WebGL mode:
                           - Downloads all 3D assets (.glb, .gltf, .hdr, .wasm)
                           - Preserves <canvas> as live 3D (NOT replaced with image)
                           - Downloads Three.js ecosystem locally (./assets/cdn/)
                           - Generates serve.sh for local HTTP serving
  --wait-for-canvas      Wait until Three.js canvas has rendered before capture

Notes:
  - Three.js sites need HTTP (not file://) to work.
    After cloning: cd <output> && bash serve.sh
  - All animation CDN scripts are downloaded LOCALLY for offline use.
  - CSS variables are harvested live from the browser (accurate dark/light values).

Examples:
  # Standard portfolio with Framer Motion + theme toggle
  bun run index.ts https://rana-dolui.vercel.app/ ./output --dynamic --wait 5000

  # Svelte + Three.js hero
  bun run index.ts https://lumoslab.tech ./output --dynamic --three --wait 8000

  # Full 3D interactive site (Bruno Simon)
  bun run index.ts https://bruno-simon.com ./output --dynamic --three --wait-for-canvas --wait 12000

  # Standard SPA
  bun run index.ts https://spa-app.com ./output --dynamic

  # Protected site
  bun run index.ts https://protected.com ./output --stealth
`);
  process.exit(0);
}

// ── Argument parsing ───────────────────────────────────────────────────────

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function getArgInt(flag: string, defaultVal: number): number {
  const val = getArgValue(flag);
  return val ? parseInt(val, 10) : defaultVal;
}

const pageUrl = args[0] ?? "";
const secondArg = args[1];
const outputDir =
  secondArg && !secondArg.startsWith("--")
    ? path.resolve(secondArg)
    : path.resolve("./scraped_output");

const forceDynamic = args.includes("--dynamic");
const forceStatic = args.includes("--static");
const isManualLogin = args.includes("--manual-login");
const forceStealth = args.includes("--stealth");
const forceNoStealth = args.includes("--no-stealth");
const interact = args.includes("--interact");
const captureCanvas = args.includes("--capture-canvas");
const forceThree = args.includes("--three");
const waitForCanvas = args.includes("--wait-for-canvas");

const cookiesFile = getArgValue("--cookies");
const proxyUrl = getArgValue("--proxy");
const extraWaitMs = getArgInt("--wait", 3000);
const maxScrollPasses = getArgInt("--max-scroll", 3);
const concurrency = getArgInt("--concurrency", 5);
const timeout = getArgInt("--timeout", 90000);

const loginRaw = getArgValue("--login");
let loginOptions: LoginOptions | undefined;
if (loginRaw) {
  try {
    loginOptions = JSON.parse(loginRaw) as LoginOptions;
  } catch {
    console.error("--login value is not valid JSON. Wrap it in single quotes.");
    process.exit(1);
  }
}

// ── Validate URL ───────────────────────────────────────────────────────────

try {
  new URL(pageUrl);
} catch {
  console.error(`Invalid URL: "${pageUrl}"`);
  process.exit(1);
}

// ── Enhanced auto-detection ────────────────────────────────────────────────

async function detectSite(url: string): Promise<DetectionResult> {
  const result: DetectionResult = {
    mode: "static",
    framework: null,
    botProtection: null,
    animationLibraries: [],
    needsStealth: false,
  };

  // Login/cookie flags always imply dynamic
  if (isManualLogin || loginOptions || cookiesFile) {
    result.mode = "dynamic";
    return result;
  }

  try {
    console.log("Auto-detecting rendering mode...");
    const res = await fetchWithTimeout(url, { "User-Agent": USER_AGENT }, 15000);
    const html = await res.text();
    const statusCode = res.status;

    // ── Detect bot protection ─────────────────────────────────────────────
    const botProtection = detectBotProtectionFromHtml(html, statusCode);
    if (botProtection) {
      result.botProtection = botProtection;
      result.needsStealth = true;
      result.mode = "dynamic";
      console.log(`  Bot protection detected: ${botProtection}`);
    }

    // ── Detect framework ──────────────────────────────────────────────────
    const frameworkSignals: Record<string, string[]> = {
      nextjs: ["__NEXT_DATA__", "/_next/"],
      nuxt: ["__nuxt", "__NUXT__", "data-n-head"],
      gatsby: ["window.__gatsby", "___gatsby"],
      react: ["data-reactroot", "__REACT_DEVTOOLS_GLOBAL_HOOK__"],
      remix: ["__remix_context__", "window.__remixContext"],
      svelte: ["__svelte", "__sveltekit"],
      angular: ["ng-version", "ng-app"],
      vue: ["data-server-rendered", "data-v-"],
      astro: ["astro-island", "data-astro-cid"],
      qwik: ["data-qwik"],
      alpine: ["x-data", "x-init"],
      htmx: ["hx-get", "hx-post", "hx-trigger"],
      turbo: ["data-turbo-frame", "data-turbo"],
    };

    for (const [name, signals] of Object.entries(frameworkSignals)) {
      if (signals.some((sig) => html.includes(sig))) {
        result.framework = name;
        result.mode = "dynamic";
        break;
      }
    }

    // ── Detect animation libraries ────────────────────────────────────────
    if (html.includes("framer-motion") || html.includes("data-framer-")) {
      result.animationLibraries.push("framer-motion");
    }
    if (html.includes("gsap") || html.includes("TweenMax") || html.includes("GreenSock")) {
      result.animationLibraries.push("gsap");
    }
    if (html.includes("data-aos") || html.includes("aos.js")) {
      result.animationLibraries.push("aos");
    }
    if (html.includes("animate__")) {
      result.animationLibraries.push("animate-css");
    }
    if (html.includes("lottie-player") || html.includes("lottie-web")) {
      result.animationLibraries.push("lottie");
    }

    // ── Thin body heuristic ───────────────────────────────────────────────
    if (result.mode === "static") {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyContent = bodyMatch?.[1] ?? "";
      if (bodyContent.replace(/\s+/g, "").length < 500) {
        result.mode = "dynamic";
      }
    }

    return result;
  } catch {
    // If we can't fetch, assume dynamic (browser handles redirects etc.)
    result.mode = "dynamic";
    return result;
  }
}

// ── Determine mode ─────────────────────────────────────────────────────────

let detection: DetectionResult;

if (forceDynamic) {
  detection = { mode: "dynamic", framework: null, botProtection: null, animationLibraries: [], needsStealth: false };
} else if (forceStatic) {
  detection = { mode: "static", framework: null, botProtection: null, animationLibraries: [], needsStealth: false };
} else {
  detection = await detectSite(pageUrl);
}

const isDynamic = detection.mode === "dynamic";
const useStealth = forceNoStealth ? false : (forceStealth || detection.needsStealth);

// ── Print banner ────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════════╗
║              Website Cloner — bun scraper                   ║
╚══════════════════════════════════════════════════════════════╝
  URL       : ${pageUrl}
  Output    : ${outputDir}
  Mode      : ${isDynamic ? "Dynamic (Chromium)" : "Static (fetch + cheerio)"}${detection.framework ? `\n  Framework : ${detection.framework}` : ""}${detection.botProtection ? `\n  Protection: ${detection.botProtection}` : ""}${useStealth ? "\n  Stealth   : enabled" : ""}${detection.animationLibraries.length ? `\n  Animations: ${detection.animationLibraries.join(", ")}` : ""}${cookiesFile ? `\n  Cookies   : ${cookiesFile}` : ""}${loginOptions ? `\n  Login     : ${loginOptions.url} (auto)` : ""}${isManualLogin ? "\n  Login     : Manual (browser window)" : ""}${proxyUrl ? `\n  Proxy     : ${proxyUrl}` : ""}${interact ? "\n  Interact  : enabled" : ""}${forceThree ? "\n  3D Mode   : Three.js canvas preserved" : ""}${waitForCanvas ? "\n  Canvas    : wait for paint" : ""}
`);

// ── Run scraper ────────────────────────────────────────────────────────────

try {
  if (isDynamic) {
    await scrapeDynamic({
      url: pageUrl,
      outputDir,
      cookiesFile,
      loginOptions,
      manualLogin: isManualLogin,
      extraWaitMs,
      concurrency,
      timeout,
      maxScrollPasses,
      interact,
      captureCanvas: captureCanvas && !forceThree, // don't capture canvas for 3D sites
      stealth: {
        enabled: useStealth,
        proxy: proxyUrl ? { server: proxyUrl } : undefined,
      },
      // Extended options passed as any (to avoid type changes)
      ...({ waitForCanvas, forceThree } as any),
    });
  } else {
    await scrapeStatic({ url: pageUrl, outputDir, concurrency, timeout });
  }
  process.exit(0);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nScraping failed: ${msg}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }

  // If dynamic mode failed, offer static fallback
  if (isDynamic && !forceDynamic) {
    console.log("\nDynamic mode failed — retrying with static mode...");
    try {
      await scrapeStatic({ url: pageUrl, outputDir, concurrency, timeout });
      process.exit(0);
    } catch (err2: unknown) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      console.error(`\nStatic fallback also failed: ${msg2}`);
    }
  }

  process.exit(1);
}
