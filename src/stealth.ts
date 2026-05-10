/**
 * Browser launch and anti-detection stealth module.
 *
 * Uses puppeteer-core for browser automation (works with Bun on Windows,
 * unlike Playwright which has pipe-based connection issues with Bun).
 *
 * Provides stealthy launch options and init scripts to evade bot detection.
 */

import puppeteer from "puppeteer-core";
import type {
  Browser,
  Page,
} from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";
import { type StealthConfig, USER_AGENT } from "./config.js";

// Re-export puppeteer types for use in other modules
export type { Browser, Page };
export type BrowserContext = Awaited<ReturnType<Browser["createBrowserContext"]>>;

// ── Launch args ─────────────────────────────────────────────────────────

const STEALTH_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--window-size=1920,1080",
  "--start-maximized",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

const BASIC_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

// ── Stealth init scripts ────────────────────────────────────────────────

const STEALTH_INIT_SCRIPTS = [
  `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,

  `window.chrome = window.chrome || {};
   window.chrome.runtime = window.chrome.runtime || {
     connect: function() {},
     sendMessage: function() {},
   };`,

  `const __origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
   window.navigator.permissions.query = (params) =>
     params.name === 'notifications'
       ? Promise.resolve({ state: Notification.permission, onchange: null, addEventListener: ()=>{}, removeEventListener: ()=>{}, dispatchEvent: ()=>true })
       : __origQuery(params);`,

  `Object.defineProperty(navigator, 'plugins', {
     get: () => {
       const arr = [
         { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
         { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
         { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
       ];
       arr.length = 3;
       return arr;
     },
   });`,

  `const __getParam = WebGLRenderingContext.prototype.getParameter;
   WebGLRenderingContext.prototype.getParameter = function(p) {
     if (p === 37445) return 'Google Inc. (NVIDIA)';
     if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
     return __getParam.call(this, p);
   };`,
];

// ── Browser detection ───────────────────────────────────────────────────

function findPlaywrightChromium(): string | undefined {
  // Linux/macOS: ~/.cache/ms-playwright
  const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "~", ".cache");
  const linuxPlaywright = path.join(xdgCache, "ms-playwright");
  // Windows: %LOCALAPPDATA%\ms-playwright
  const winPlaywright = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");

  for (const base of [linuxPlaywright, winPlaywright]) {
    if (!fs.existsSync(base)) continue;
    try {
      const dirs = fs.readdirSync(base);
      const chromiumDir = dirs
        .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
        .sort()
        .pop();
      if (!chromiumDir) continue;
      // Linux binary
      for (const bin of [
        path.join(base, chromiumDir, "chrome-linux", "chrome"),
        path.join(base, chromiumDir, "chrome-linux64", "chrome"),
        path.join(base, chromiumDir, "chrome-win64", "chrome.exe"),
      ]) {
        if (fs.existsSync(bin)) return bin;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

function findSystemBrowser(): string | undefined {
  const candidates = [
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

// ── Browser launcher ────────────────────────────────────────────────────

/**
 * Launch a browser using puppeteer-core.
 * Tries Playwright's bundled Chromium first, then system Chrome/Edge.
 */
export async function launchStealthBrowser(
  headless: boolean,
  stealth: StealthConfig = { enabled: false }
): Promise<Browser> {
  const args = stealth.enabled ? STEALTH_LAUNCH_ARGS : BASIC_LAUNCH_ARGS;

  // Collect candidate executables
  const candidates: Array<{ name: string; path: string }> = [];

  const pwChromium = findPlaywrightChromium();
  if (pwChromium) candidates.push({ name: "Playwright Chromium", path: pwChromium });

  const systemBrowser = findSystemBrowser();
  if (systemBrowser) candidates.push({ name: path.basename(systemBrowser), path: systemBrowser });

  for (const candidate of candidates) {
    try {
      console.log(`  🔄 Trying: ${candidate.name}...`);
      const browser = await puppeteer.launch({
        executablePath: candidate.path,
        headless,
        args,
        timeout: 30000,
        protocolTimeout: 60000,
        ...(stealth.proxy ? {
          args: [...args, `--proxy-server=${stealth.proxy.server}`],
        } : {}),
      });
      console.log(`  ✅ Launched: ${candidate.name}`);
      return browser;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️  Failed: ${candidate.name} — ${msg.split("\n")[0]}`);
    }
  }

  throw new Error(
    "No browser could be launched.\n" +
      "Install Google Chrome, Microsoft Edge, or run: npx playwright install chromium"
  );
}

/**
 * Apply stealth scripts to a page for bot evasion.
 */
export async function applyStealthToPage(
  page: Page,
  stealth: StealthConfig = { enabled: false }
): Promise<void> {
  // Set user agent
  await page.setUserAgent(USER_AGENT);

  // Set viewport
  await page.setViewport({ width: 1920, height: 1080 });

  if (stealth.enabled) {
    // Inject stealth scripts before any page navigation
    for (const script of STEALTH_INIT_SCRIPTS) {
      await page.evaluateOnNewDocument(script);
    }
  }
}
