/**
 * Three.js / WebGL Scene Cloner
 *
 * Handles full 3D scene preservation for websites using Three.js, Babylon.js,
 * or any WebGL-based renderer. Strategy:
 *
 *   1. Inject fetch/XHR monkey-patch BEFORE navigation → capture all 3D asset URLs
 *   2. Collect all 3D binary asset URLs after page settles
 *   3. Preserve <canvas> elements (never replace with static images)
 *   4. Download Three.js ecosystem locally for offline use
 *   5. Generate serve.sh so the user can run a local HTTP server
 *
 * Why HTTP server is required:
 *   GLTFLoader, TextureLoader, etc. use fetch() which fails on file:// due to CORS.
 *   The cloned site must be served via npx serve or similar.
 */

import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";

// ── Pre-navigation intercept script ──────────────────────────────────────────

/**
 * Injected via page.evaluateOnNewDocument() BEFORE navigation.
 * Monkey-patches fetch and XHR to record every URL the page requests.
 * Three.js loaders (GLTFLoader, TextureLoader, etc.) all go through these.
 */
export const THREE_NETWORK_INTERCEPT_SCRIPT = `
(function() {
  'use strict';
  if (window.__scraperThreeIntercepted) return;
  window.__scraperThreeIntercepted = true;
  window.__scraperThreeAssets = new Set();

  // ── Patch fetch ──────────────────────────────────────────────────────────
  var _fetchOrig = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input
            : (input && input.url) ? input.url
            : String(input);
    if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
      window.__scraperThreeAssets.add(url);
    }
    return _fetchOrig.apply(this, arguments);
  };

  // ── Patch XMLHttpRequest ─────────────────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url && typeof url === 'string' && !url.startsWith('data:') && !url.startsWith('blob:')) {
      window.__scraperThreeAssets.add(url);
    }
    return _xhrOpen.apply(this, arguments);
  };

  // ── Patch Image src ──────────────────────────────────────────────────────
  // Three.js TextureLoader creates Image elements
  var _imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (_imgSrcDesc && _imgSrcDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      set: function(val) {
        if (val && !val.startsWith('data:') && !val.startsWith('blob:')) {
          window.__scraperThreeAssets.add(val);
        }
        _imgSrcDesc.set.call(this, val);
      },
      get: _imgSrcDesc.get,
      configurable: true,
    });
  }

  console.log('[Scraper] Three.js asset intercept installed');
})();
`;

// ── 3D asset extension list ───────────────────────────────────────────────────

export const THREEJS_ASSET_EXTENSIONS = [
  ".glb", ".gltf", ".hdr", ".exr",
  ".basis", ".ktx2", ".ktx",
  ".wasm", ".bin", ".draco",
  ".dds", ".pvr",                   // legacy compressed textures
  ".obj", ".mtl", ".fbx",           // other 3D formats
  ".vert", ".frag", ".glsl",        // shaders
];

// ── CDN assets to download locally for Three.js ──────────────────────────────

export interface ThreeCdnAsset {
  url: string;
  localName: string;
}

export function getThreeCdnAssets(threeRevision: string | null): ThreeCdnAsset[] {
  // Determine version — rev 163 = v0.163.0
  const ver = threeRevision ? `0.${threeRevision}.0` : "0.163.0";
  const base = `https://cdn.jsdelivr.net/npm/three@${ver}/build`;
  const addons = `https://cdn.jsdelivr.net/npm/three@${ver}/examples/jsm`;

  return [
    // Core Three.js (UMD for non-module pages, ESM for ES module pages)
    { url: `${base}/three.min.js`,           localName: "three.min.js" },
    { url: `${base}/three.module.min.js`,    localName: "three.module.min.js" },
    // Loaders
    { url: `${addons}/loaders/GLTFLoader.js`,    localName: "GLTFLoader.js" },
    { url: `${addons}/loaders/DRACOLoader.js`,   localName: "DRACOLoader.js" },
    { url: `${addons}/loaders/RGBELoader.js`,    localName: "RGBELoader.js" },
    { url: `${addons}/loaders/KTX2Loader.js`,    localName: "KTX2Loader.js" },
    { url: `${addons}/loaders/EXRLoader.js`,     localName: "EXRLoader.js" },
    { url: `${addons}/loaders/FontLoader.js`,    localName: "FontLoader.js" },
    // Controls
    { url: `${addons}/controls/OrbitControls.js`,    localName: "OrbitControls.js" },
    { url: `${addons}/controls/PointerLockControls.js`, localName: "PointerLockControls.js" },
    { url: `${addons}/controls/FirstPersonControls.js`, localName: "FirstPersonControls.js" },
    // Post-processing
    { url: `${addons}/postprocessing/EffectComposer.js`,  localName: "EffectComposer.js" },
    { url: `${addons}/postprocessing/RenderPass.js`,      localName: "RenderPass.js" },
    { url: `${addons}/postprocessing/UnrealBloomPass.js`, localName: "UnrealBloomPass.js" },
    { url: `${addons}/postprocessing/ShaderPass.js`,      localName: "ShaderPass.js" },
    // Helpers
    { url: `${addons}/utils/BufferGeometryUtils.js`, localName: "BufferGeometryUtils.js" },
  ];
}

// ── Collect 3D assets from live page ─────────────────────────────────────────

/**
 * Run in browser via page.evaluate() AFTER the page settles.
 * Returns all 3D asset URLs intercepted by the monkey-patch.
 */
export const COLLECT_THREE_ASSETS_SCRIPT = `(function() {
  var assets = window.__scraperThreeAssets;
  if (!assets) return JSON.stringify([]);

  var filtered = Array.from(assets).filter(function(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return false;
    var lower = url.toLowerCase().split('?')[0];
    var ext = lower.slice(lower.lastIndexOf('.'));
    return [
      '.glb','.gltf','.hdr','.exr','.basis','.ktx2','.ktx',
      '.wasm','.bin','.draco','.dds','.pvr','.obj','.mtl','.fbx',
      '.vert','.frag','.glsl'
    ].indexOf(ext) !== -1;
  });

  return JSON.stringify(filtered);
})();`;

/**
 * Detect Three.js version and scene information from the live page.
 */
export const DETECT_THREE_INFO_SCRIPT = `(function() {
  var info = {
    revision: null,
    hasWebGPU: false,
    hasWebGL2: false,
    rendererType: null,
    canvasCount: 0,
    hasPhysics: false,
    hasPostProcessing: false,
  };

  if (window.THREE) {
    info.revision = window.THREE.REVISION || null;
    info.hasPostProcessing = !!(window.THREE.EffectComposer);
  }

  var canvases = document.querySelectorAll('canvas');
  info.canvasCount = canvases.length;

  // Detect WebGPU vs WebGL
  if (window.GPUCanvasContext || navigator.gpu) info.hasWebGPU = true;
  try {
    if (canvases.length > 0) {
      var ctx = canvases[0].getContext('webgl2') || canvases[0].getContext('webgl');
      if (ctx) info.hasWebGL2 = !!(canvases[0].getContext('webgl2'));
    }
  } catch(e) {}

  // Physics engines
  info.hasPhysics = !!(window.CANNON || window.Ammo || window.Rapier || window.PhysicsWorld);

  // Renderer type (check for common patterns)
  var scripts = document.querySelectorAll('script[src]');
  for (var i = 0; i < scripts.length; i++) {
    var src = (scripts[i].src || '').toLowerCase();
    if (src.includes('cannon') || src.includes('ammo')) info.hasPhysics = true;
  }

  return JSON.stringify(info);
})();`;

// ── Canvas preservation ───────────────────────────────────────────────────────

/**
 * In the cheerio DOM, mark canvas elements to NOT be replaced with images.
 * Also add a loading indicator overlay so the user sees something while
 * the Three.js scene initializes.
 */
export function preserveCanvasElements(
  $: ReturnType<typeof cheerio.load>,
  threeInfo: { canvasCount: number; hasWebGPU: boolean }
): void {
  $("canvas").each((_, el) => {
    $(el).attr("data-scraper-preserve-canvas", "true");
    // Ensure canvas has explicit dimensions (prevents collapse during re-render)
    if (!$(el).attr("width")) $(el).attr("width", "100%");
    if (!$(el).attr("height")) $(el).attr("height", "100%");
  });

  // Inject a "loading 3D scene..." overlay that auto-hides once canvas paints
  if (threeInfo.canvasCount > 0) {
    $("body").prepend(`
<div id="scraper-3d-loading" style="
  position:fixed;inset:0;z-index:9999;
  background:#000;color:#fff;
  display:flex;align-items:center;justify-content:center;
  font-family:system-ui,sans-serif;font-size:1.2rem;
  pointer-events:none;
  transition:opacity 1s ease;
">
  <div style="text-align:center">
    <div style="margin-bottom:12px;font-size:2rem">⬡</div>
    <div>Initializing 3D Scene…</div>
    ${threeInfo.hasWebGPU ? '<div style="margin-top:8px;font-size:0.8rem;opacity:0.6">WebGPU · Chrome 113+ required</div>' : ''}
  </div>
</div>
<script>
(function() {
  var overlay = document.getElementById('scraper-3d-loading');
  if (!overlay) return;
  function checkCanvas() {
    var canvas = document.querySelector('canvas[data-scraper-preserve-canvas]');
    if (!canvas) { overlay.style.opacity = '0'; setTimeout(function(){ overlay.remove(); }, 1000); return; }
    try {
      var ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (ctx) {
        var px = new Uint8Array(4);
        ctx.readPixels(canvas.width/2|0, canvas.height/2|0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        if (px[3] > 0) {
          overlay.style.opacity = '0';
          setTimeout(function(){ overlay.remove(); }, 1000);
          return;
        }
      }
    } catch(e) {}
    setTimeout(checkCanvas, 200);
  }
  setTimeout(checkCanvas, 1000);
})();
</script>`);
  }
}

// ── Inject Three.js local CDN scripts into HTML ───────────────────────────────

/**
 * Inject Three.js and its loaders from local ./assets/cdn/ directory.
 * These files are downloaded during the scrape phase.
 */
export function injectThreeCdnScripts(
  $: ReturnType<typeof cheerio.load>,
  threeRevision: string | null
): void {
  // We inject as importmap + module scripts where possible,
  // with UMD fallback for non-module pages
  const cdnBase = "./assets/cdn";

  $("head").append(`
<!-- Three.js offline CDN (downloaded by scraper) -->
<script type="importmap">
{
  "imports": {
    "three": "${cdnBase}/three.module.min.js",
    "three/addons/": "${cdnBase}/"
  }
}
</script>`);

  // Non-module fallback
  $("body").append(`
<script>
// Three.js UMD fallback for non-ESM scripts
if (typeof THREE === 'undefined') {
  var s = document.createElement('script');
  s.src = '${cdnBase}/three.min.js';
  document.head.appendChild(s);
}
</script>`);
}

// ── serve.sh generation ───────────────────────────────────────────────────────

/**
 * Generate a serve.sh script so the user can easily start a local HTTP server.
 * Three.js requires HTTP context (fetch() fails on file://).
 */
export function generateServeScript(outputDir: string): void {
  const serveShContent = `#!/bin/bash
# ────────────────────────────────────────────────────────────
# Local server for cloned 3D site
# Required: Three.js uses fetch() which needs HTTP context.
# ────────────────────────────────────────────────────────────

PORT=\${1:-8080}

echo ""
echo "  ⬡  Starting 3D scene server..."
echo "  📂  Serving: $(pwd)"
echo ""

# Try npx serve first, then python, then php
if command -v npx &> /dev/null; then
  echo "  🌐  Open: http://localhost:\$PORT"
  echo ""
  npx serve . -p \$PORT --no-clipboard
elif command -v python3 &> /dev/null; then
  echo "  🌐  Open: http://localhost:\$PORT"
  echo ""
  python3 -m http.server \$PORT
elif command -v php &> /dev/null; then
  echo "  🌐  Open: http://localhost:\$PORT"
  echo ""
  php -S localhost:\$PORT
else
  echo "  ❌  No HTTP server found. Install Node.js and run:"
  echo "  npx serve . -p \$PORT"
  exit 1
fi
`;

  const servePath = path.join(outputDir, "serve.sh");
  fs.writeFileSync(servePath, serveShContent, "utf-8");
  fs.chmodSync(servePath, "755");

  const readmeNote = `\n\n## ⬡ 3D Scene — How to View\n\nThis clone contains a Three.js 3D scene.\n**You must serve it via HTTP** (not file://):\n\n\`\`\`bash\nbash serve.sh\n# Then open: http://localhost:8080\n\`\`\`\n\nOr: \`npx serve . -p 8080\`\n`;
  const readmePath = path.join(outputDir, "README.md");
  fs.writeFileSync(readmePath, readmeNote, "utf-8");

  console.log(`   🚀 Generated serve.sh — run it to view the 3D scene`);
}

// ── JS bundle URL rewriting ───────────────────────────────────────────────────

/**
 * Rewrite 3D asset URL strings INSIDE minified JS bundles.
 * Three.js loaders reference asset paths as string literals in the bundle.
 */
export function rewriteUrlsInJsBundle(
  jsContent: string,
  assetMap: Map<string, string>,
  bundleLocalPath: string
): string {
  let rewritten = jsContent;

  for (const [originalUrl, localPath] of assetMap.entries()) {
    if (!originalUrl || !localPath) continue;

    // Skip non-3D assets for performance (only rewrite 3D-relevant paths)
    const ext = path.extname(originalUrl.split("?")[0] ?? "").toLowerCase();
    const is3dAsset = THREEJS_ASSET_EXTENSIONS.includes(ext);
    const isScript = ext === ".js" || ext === ".mjs";
    if (!is3dAsset && !isScript) continue;

    // Compute relative path from the bundle's location to the asset
    const bundleDir = path.dirname(bundleLocalPath);
    const relPath = path.relative(bundleDir, localPath).replace(/\\/g, "/");

    // Replace URL as string literal (handles ", ', ` quoting)
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rewritten = rewritten
      .replace(new RegExp(`"${escaped}"`, "g"), `"${relPath}"`)
      .replace(new RegExp(`'${escaped}'`, "g"), `'${relPath}'`)
      .replace(new RegExp(`\`${escaped}\``, "g"), `\`${relPath}\``);

    // Also handle just the pathname portion (for relative URL patterns)
    try {
      const u = new URL(originalUrl);
      const pn = u.pathname;
      const escPn = pn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (pn.length > 3) {
        rewritten = rewritten
          .replace(new RegExp(`"${escPn}"`, "g"), `"${relPath}"`)
          .replace(new RegExp(`'${escPn}'`, "g"), `'${relPath}'`);
      }
    } catch { /* */ }
  }

  return rewritten;
}

// ── WASM decoder path rewriting ───────────────────────────────────────────────

/**
 * Draco and Basis WASM decoders have their own path-setting APIs.
 * Inject a script override into the HTML to redirect them to local copies.
 */
export function injectWasmPathOverride(
  $: ReturnType<typeof cheerio.load>,
  assetMap: Map<string, string>
): void {
  const wasmEntries: Array<{ name: string; localPath: string }> = [];

  for (const [url, localPath] of assetMap.entries()) {
    const lower = url.toLowerCase();
    if (lower.includes("draco")) {
      wasmEntries.push({ name: "draco", localPath });
    } else if (lower.includes("basis")) {
      wasmEntries.push({ name: "basis", localPath });
    }
  }

  if (wasmEntries.length === 0) return;

  const overrideScript = `
<script data-scraper-wasm-override="true">
// Redirect WASM decoder paths to local files
(function() {
${wasmEntries.map(({ name, localPath }) => `
  // ${name} decoder override
  Object.defineProperty(window, '__scraper_${name}_path', { value: './${localPath}', writable: false });
`).join("")}

  // Patch DRACOLoader setDecoderPath if called
  var _origDefine = window.define;
  var _origRequire = window.require;

  // Intercept THREE.DRACOLoader.setDecoderPath()
  var _dracoPath = './${wasmEntries.find(e => e.name === "draco")?.localPath ?? "assets/cdn/draco/"}';
  if (typeof THREE !== 'undefined' && THREE.DRACOLoader) {
    var _orig = THREE.DRACOLoader.prototype.setDecoderPath;
    THREE.DRACOLoader.prototype.setDecoderPath = function() {
      return _orig.call(this, _dracoPath);
    };
  }
})();
</script>`;

  $("head").prepend(overrideScript);
}
