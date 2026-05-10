# Universal Web Cloner — Same-to-Same Interactive Clone (Updated Plan)

## Goal

**Zero static fallbacks.** Every cloned site must be:
- Fully interactive (scrolling triggers animations, buttons work, tabs switch)
- Theme-aware (dark/light toggle works, CSS variables swap correctly)  
- 3D-faithful (Three.js scenes re-render, physics run, canvas stays live)
- Animation-complete (Framer Motion, GSAP, CSS keyframes all replay natively)
- Asset-complete (all fonts, models, shaders, WASM decoders downloaded locally)

Reference targets confirmed:
| Site | Framework | Animation | 3D/Canvas | Theme |
|---|---|---|---|---|
| rana-dolui.vercel.app | Next.js + React | Framer Motion + tsParticles | tsParticles canvas | ✅ dark/light toggle |
| lumoslab.tech | Svelte + SvelteKit | Svelte transitions + GSAP | Three.js hero canvas | Fixed dark |
| bruno-simon.com | Vanilla JS | GSAP | **Full Three.js** (WebGPU + WebGL2) | Fixed |

---

## Critical Architecture Principle

The fundamental strategy shift:

> **Preserve & Replay > Freeze & Screenshot**
>
> ❌ Old approach: capture final DOM state, replace canvas with image, inject CSS fallbacks  
> ✅ New approach: keep ALL scripts alive, rewrite asset URLs to local, let the browser re-run everything natively

This means:
1. **Scripts stay alive** — original JS bundles are downloaded and served locally, asset paths rewritten
2. **Canvas never replaced** — Three.js and particle canvases keep their `<canvas>` elements
3. **CDN scripts downloaded** — animation CDNs (GSAP, Three.js, AOS) are downloaded locally, not re-fetched
4. **Fetch/XHR intercepted** — every network request the JS makes (GLTF, HDR, WASM) is captured during scrape
5. **CORS solved** — local file serving rewrites all URLs; relative paths work offline

---

## User Review Required

> [!IMPORTANT]
> **Bruno Simon (WebGPU fallback)**: The site uses `WebGPURenderer` with fallback to WebGL2. WebGPU only works in Chromium-based browsers (Chrome 113+, Edge). When opened as `file://`, the full 3D scene will work in Chrome but may not in Firefox/Safari. This is a browser limitation, not a scraper limitation.

> [!WARNING]
> **Local file:// vs HTTP server**: Three.js GLTF loaders using `fetch()` require HTTP context — they fail on `file://` due to CORS. The cloned output needs to be served via `npx serve` or similar. We should auto-generate a `serve.sh` start script and warn the user.

> [!IMPORTANT]
> **Script rewriting scope**: Original JS bundles (Next.js chunks, Svelte bundles) are complex minified code. We preserve them as-is and only rewrite asset URL strings inside them (e.g., replace `"/_next/static/media/model.glb"` with `"./rana-dolui.vercel.app/_next/static/media/model.glb"`). We do NOT transpile or modify the JS logic.

---

## Proposed Changes

---

### Component 1: Live CSS Variable Harvesting (Root Fix for Theme)

#### [MODIFY] [dynamic-scraper.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/dynamic-scraper.ts)

**Problem**: We read CSS variable values from downloaded CSS text files. These files may have browser-resolved values `lab(100% 0 0)` or missing values if variables are set by JavaScript (e.g., `next-themes` sets `--background` at runtime).

**Fix — Harvest from live `getComputedStyle` in the browser**:

After the page settles (after animations, after theme JS runs), inject this capture script:

```javascript
// Run in page.evaluate() — captures ALL CSS custom properties from live DOM
const cssVarHarvest = await page.evaluate(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  
  const harvest = { root: {}, dark: {}, themes: {} };
  
  // Get ALL custom properties currently on :root
  for (const name of cs) {
    if (name.startsWith('--')) {
      harvest.root[name] = cs.getPropertyValue(name).trim();
    }
  }
  
  // Switch to dark mode temporarily to harvest dark vars
  const wasDark = root.classList.contains('dark');
  root.classList.add('dark');
  root.setAttribute('data-theme', 'dark');
  const csDark = getComputedStyle(root);
  for (const name of csDark) {
    if (name.startsWith('--')) {
      harvest.dark[name] = csDark.getPropertyValue(name).trim();
    }
  }
  // Restore
  if (!wasDark) {
    root.classList.remove('dark');
    root.setAttribute('data-theme', 'light');
  }
  
  return harvest;
});
```

This guarantees we get the **actual browser-computed values** including any set by JS frameworks.

Pass `cssVarHarvest` to `injectStaticEnhancement()` instead of the current `cssTexts` approach.

---

### Component 2: Theme Toggle — Universal Detection & Full Attribute Sync

#### [MODIFY] [static-enhance.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/static-enhance.ts)

**Complete rewrite of theme detection and `setTheme()`**:

**Detection** — expanded to catch ALL known patterns:
```javascript
// Priority order — try each detector in sequence
const detectors = [
  // 1. aria-label match (most reliable)
  el => /theme|dark.?mode|light.?mode|color.?scheme|toggle.?mode|switch.?mode/i.test(
    el.getAttribute('aria-label') || el.title || ''
  ),
  // 2. next-themes data-attribute
  el => el.hasAttribute('data-theme-toggle') || 
        el.closest('[data-theme-toggle]'),
  // 3. SVG icon analysis — check path d="" for moon/sun shape signatures
  el => {
    const paths = el.querySelectorAll('path');
    for (const p of paths) {
      const d = p.getAttribute('d') || '';
      // Moon shape: arc commands + M near center
      if (/M\s*2[01]/.test(d) && d.includes('A')) return true;
      // Sun shape: multiple radiating lines (M + L patterns)
      if ((d.match(/M\s*\d+/g) || []).length > 5) return true;
    }
    return false;
  },
  // 4. Button class patterns
  el => /theme|dark|light|mode-toggle|color-scheme|sun|moon/i.test(
    el.className + (el.id || '')
  ),
  // 5. next-themes: button that is child of ThemeProvider span
  el => el.closest('[data-nextjs-scroll-focus-boundary]') ||
        el.closest('[suppresshydrationwarning]')
];
```

**`setTheme()` — sync ALL known theme attributes simultaneously**:
```javascript
function setTheme(dark) {
  const html = document.documentElement;
  const body = document.body;
  
  // Transition class for smooth color change
  html.classList.add('scraper-theme-transition');
  
  // ── Attribute sync (covers ALL known theme frameworks) ──
  // Class-based (Tailwind, shadcn/ui, next-themes default)
  html.classList.toggle('dark', dark);
  html.classList.toggle('light', !dark);
  body.classList.toggle('dark', dark);
  body.classList.toggle('light', !dark);
  
  // Attribute-based (next-themes, custom)
  const val = dark ? 'dark' : 'light';
  html.setAttribute('data-theme', val);
  html.setAttribute('data-color-mode', val);
  html.setAttribute('data-mode', val);
  html.setAttribute('color-scheme', dark ? 'dark' : 'normal');
  body.setAttribute('data-theme', val);
  body.setAttribute('data-bs-theme', val);  // Bootstrap 5
  
  // color-scheme CSS property
  html.style.colorScheme = dark ? 'dark' : 'light';
  
  // ── CSS variable injection ──
  // Apply all harvested vars directly on :root
  const vars = dark ? DARK_VARS : ROOT_VARS;
  Object.entries(vars).forEach(([k, v]) => {
    if (v) html.style.setProperty(k, v);
  });
  
  // Save + cleanup
  try { localStorage.setItem('theme', val); } catch(e) {}
  setTimeout(() => html.classList.remove('scraper-theme-transition'), 350);
}
```

**`extractCssVars()` — replace broken regex with brace-balanced parser**:

```typescript
function extractCssVarsBalanced(cssTexts: string[], selectors: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  
  for (const css of cssTexts) {
    for (const selector of selectors) {
      let i = 0;
      while (i < css.length) {
        const idx = css.indexOf(selector, i);
        if (idx === -1) break;
        
        const openBrace = css.indexOf('{', idx);
        if (openBrace === -1) break;
        
        // Check nothing but whitespace between selector and {
        const between = css.slice(idx + selector.length, openBrace).trim();
        if (between && !between.startsWith('/*')) { i = openBrace + 1; continue; }
        
        // Balance braces
        let depth = 0, end = openBrace;
        while (end < css.length) {
          if (css[end] === '{') depth++;
          else if (css[end] === '}') { depth--; if (depth === 0) { end++; break; } }
          end++;
        }
        
        const block = css.slice(openBrace + 1, end - 1);
        // Parse declarations
        block.split(';').forEach(decl => {
          const colonIdx = decl.indexOf(':');
          if (colonIdx < 0) return;
          const key = decl.slice(0, colonIdx).trim();
          const val = decl.slice(colonIdx + 1).trim();
          if (key.startsWith('--') && val) vars[key] = val;
        });
        
        i = end;
      }
    }
  }
  return vars;
}

// Expanded selector list
const DARK_SELECTORS = [
  '.dark',
  '[data-theme="dark"]',
  '[data-color-mode="dark"]',
  '[data-mode="dark"]',
  'html.dark',
  'html[data-theme="dark"]',
  '.theme-dark',
  'body.dark',
];
```

---

### Component 3: Framer Motion — Per-Element Variant Capture & Replay

#### [MODIFY] [dynamic-scraper.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/dynamic-scraper.ts)

**Add Phase: Framer Motion variant capture** — before freezing, read the computed styles of ALL Framer Motion elements and tag them with their initial animation state:

```javascript
// In page.evaluate() — tag each Framer element with what it animates FROM
await page.evaluate(() => {
  document.querySelectorAll('[data-framer-appear-id], [data-projection-id]').forEach(el => {
    // Read Framer's internal state from data attributes
    const initial = el.getAttribute('data-framer-initial') || '';
    const animate = el.getAttribute('data-framer-animate') || '';
    
    // Detect animation type from class names and style
    const cs = getComputedStyle(el);
    const tag = {
      hasOpacity: cs.opacity !== '1',
      hasTranslateY: /translateY\((?!0)/.test(cs.transform),
      hasScale: /scale\((?!1)/.test(cs.transform),
      hasRotate: /rotate\(/.test(cs.transform),
      hasBlur: /blur\([1-9]/.test(cs.filter),
      hasClipPath: cs.clipPath !== 'none' && cs.clipPath !== '',
      delay: el.getAttribute('data-framer-delay') || '0',
      duration: el.getAttribute('data-framer-duration') || '0.5',
    };
    
    el.setAttribute('data-scraper-fm-type', JSON.stringify(tag));
  });
});
```

#### [MODIFY] [cdn-injector.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/cdn-injector.ts)

**`injectFramerMotionCssFallback()` — generate per-element CSS variants**:

After reading `data-scraper-fm-type` from the DOM, generate targeted CSS:

```typescript
export function injectFramerMotionCssFallback($: ..., variants: FramerVariantMap): void {
  // Build per-type keyframe rules
  const rules: string[] = [
    `@keyframes fm-fade-up { from { opacity:0; transform:translateY(24px); } to { opacity:1; transform:translateY(0); } }`,
    `@keyframes fm-fade-in { from { opacity:0; } to { opacity:1; } }`,
    `@keyframes fm-scale-in { from { opacity:0; transform:scale(0.85); } to { opacity:1; transform:scale(1); } }`,
    `@keyframes fm-slide-left { from { opacity:0; transform:translateX(-32px); } to { opacity:1; transform:translateX(0); } }`,
    `@keyframes fm-slide-right { from { opacity:0; transform:translateX(32px); } to { opacity:1; transform:translateX(0); } }`,
    `@keyframes fm-blur-in { from { opacity:0; filter:blur(12px); } to { opacity:1; filter:blur(0); } }`,
    `@keyframes fm-reveal { from { clip-path:inset(0 100% 0 0); } to { clip-path:inset(0 0% 0 0); } }`,
    `@keyframes fm-rotate-x { from { opacity:0; transform:perspective(600px) rotateX(20deg); } to { opacity:1; transform:perspective(600px) rotateX(0); } }`,
  ];

  // Select correct animation for each element based on its data-scraper-fm-type
  const assignScript = `
  document.querySelectorAll('[data-scraper-fm-type]').forEach(function(el) {
    var tag = JSON.parse(el.getAttribute('data-scraper-fm-type') || '{}');
    var anim = 'fm-fade-up'; // default
    var delay = parseFloat(tag.delay || 0) * 1000;
    
    if (tag.hasClipPath)   anim = 'fm-reveal';
    else if (tag.hasBlur)  anim = 'fm-blur-in';
    else if (tag.hasScale) anim = 'fm-scale-in';
    else if (tag.hasRotate) anim = 'fm-rotate-x';
    else if (!tag.hasTranslateY && tag.hasOpacity) anim = 'fm-fade-in';
    
    el.style.opacity = '0';
    el.style.animationName = anim;
    el.style.animationDuration = (parseFloat(tag.duration || 0.5)) + 's';
    el.style.animationTimingFunction = 'cubic-bezier(0.33, 1, 0.68, 1)';
    el.style.animationFillMode = 'both';
    el.style.animationDelay = delay + 'ms';
    el.style.animationPlayState = 'paused'; // wait for scroll trigger
    
    el.setAttribute('data-scraper-fm-ready', '1');
  });
  
  // IntersectionObserver fires each animation
  var io = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (!e.isIntersecting) return;
      e.target.style.animationPlayState = 'running';
      io.unobserve(e.target);
    });
  }, { threshold: 0.06, rootMargin: '0px 0px -30px 0px' });
  
  document.querySelectorAll('[data-scraper-fm-ready]').forEach(function(el) {
    io.observe(el);
  });`;
}
```

---

### Component 4: GSAP + ScrollTrigger — Full Re-initialization

#### [MODIFY] [cdn-injector.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/cdn-injector.ts)

**New GSAP init strategy** — instead of empty `initScript`, inject a smart DOM-driven re-init:

```javascript
// Runs after GSAP + ScrollTrigger load from local CDN files
if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.refresh();
  
  // Re-animate elements that were tagged during capture
  document.querySelectorAll('[data-gsap-from]').forEach(function(el) {
    try {
      var from = JSON.parse(el.getAttribute('data-gsap-from') || '{}');
      var to   = JSON.parse(el.getAttribute('data-gsap-to')   || '{}');
      
      gsap.fromTo(el, from, {
        ...to,
        scrollTrigger: {
          trigger: el,
          start: 'top 85%',
          end: 'bottom 15%',
          toggleActions: 'play none none reverse',
        }
      });
    } catch(e) {}
  });
  
  // Re-run pinned sections
  document.querySelectorAll('[data-gsap-pin]').forEach(function(el) {
    try {
      ScrollTrigger.create({
        trigger: el,
        pin: true,
        start: 'top top',
        end: '+=' + (el.getAttribute('data-gsap-pin-length') || '200%'),
      });
    } catch(e) {}
  });
}
```

#### [MODIFY] [dynamic-scraper.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/dynamic-scraper.ts)

**Tag GSAP elements during capture** — before freezing, run in browser:

```javascript
await page.evaluate(() => {
  if (!window.gsap) return;
  
  // Tag every element that GSAP has animated
  const targets = new Set();
  gsap.globalTimeline.getChildren(true, true, false).forEach(tween => {
    if (tween.targets) tween.targets().forEach(t => targets.add(t));
  });
  
  targets.forEach(el => {
    if (!(el instanceof Element)) return;
    const cs = getComputedStyle(el);
    el.setAttribute('data-gsap-to', JSON.stringify({
      opacity: cs.opacity,
      transform: cs.transform === 'none' ? '' : cs.transform,
    }));
    el.setAttribute('data-gsap-from', JSON.stringify({
      opacity: 0,
      y: 30,
    }));
  });
  
  // Tag pinned sections
  if (window.ScrollTrigger) {
    ScrollTrigger.getAll().forEach(st => {
      if (st.pin) {
        st.pin.setAttribute('data-gsap-pin', '1');
        st.pin.setAttribute('data-gsap-pin-length', st.end - st.start + 'px');
      }
    });
  }
});
```

---

### Component 5: Three.js — Full Scene Preservation (NO static fallback)

#### [NEW] [threejs-cloner.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/threejs-cloner.ts)

Complete new module. Strategy:

**Phase A — Network Interception (before navigation)**:
```typescript
// Inject fetch/XHR monkey-patch BEFORE page loads
const THREE_INTERCEPT_SCRIPT = `
(function() {
  window.__scraperThreeAssets = new Set();
  
  // Patch fetch
  const _fetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string') window.__scraperThreeAssets.add(url);
    return _fetch.apply(this, arguments);
  };
  
  // Patch XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string') window.__scraperThreeAssets.add(url);
    return _open.apply(this, arguments);
  };
  
  // Patch Three.js FileLoader (used by GLTFLoader, etc.)
  Object.defineProperty(window, '__scraperThreeReady', { value: true });
})();
`;

// Inject BEFORE navigation via page.evaluateOnNewDocument()
await page.evaluateOnNewDocument(THREE_INTERCEPT_SCRIPT);
```

**Phase B — Asset collection (after page settles)**:
```typescript
// After page loads, collect all intercepted 3D asset URLs
const threeAssets = await page.evaluate(() => {
  return Array.from(window.__scraperThreeAssets || new Set())
    .filter(url => /\.(glb|gltf|hdr|exr|basis|ktx2|wasm|bin|draco)(\?|$)/i.test(url));
});
```

**Phase C — Script preservation**:
```typescript
// Extract THREE.js version from the page
const threeVersion = await page.evaluate(() => {
  return window.THREE?.REVISION || null;
});

// Find the main Three.js bundle script
const threeScript = await page.evaluate(() => {
  for (const s of document.scripts) {
    if (s.src && /three|webgl|canvas|scene/i.test(s.src)) return s.src;
  }
  return null;
});
```

**Phase D — Canvas preservation in output HTML**:
```typescript
// In postProcessHtml — skip canvas-to-image for Three.js sites
// Add an attribute marker so the enhancement script knows
$('canvas').each((_, el) => {
  if (detectedLibs.three) {
    $(el).attr('data-scraper-preserve-canvas', 'true');
    // DON'T replace with img
  }
});
```

**Phase E — Local serve script generation**:
```typescript
// Generate serve.sh alongside index.html
fs.writeFileSync(path.join(outputDir, 'serve.sh'), 
  `#!/bin/bash\necho "Starting local server..."\nnpx serve . -p 8080\necho "Open: http://localhost:8080"\n`
);
fs.chmodSync(path.join(outputDir, 'serve.sh'), '755');
```

#### [MODIFY] [cdn-injector.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/cdn-injector.ts)

Add Three.js + ecosystem CDN entries (downloaded locally):

```typescript
threejs: {
  name: "Three.js",
  js: [
    `<script src="./assets/cdn/three.min.js"></script>`,
    `<script src="./assets/cdn/GLTFLoader.js"></script>`,
    `<script src="./assets/cdn/DRACOLoader.js"></script>`,
    `<script src="./assets/cdn/RGBELoader.js"></script>`,
    `<script src="./assets/cdn/OrbitControls.js"></script>`,
  ]
}
// These files are downloaded to ./assets/cdn/ during scrape
```

**Key insight**: instead of CDN URLs, we download Three.js addons locally into `assets/cdn/` so the 3D scene works fully offline.

---

### Component 6: Binary Asset Pipeline (GLTF, HDR, WASM, Draco)

#### [MODIFY] [asset-downloader.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/asset-downloader.ts)

**Expand the resource interceptor** to handle binary 3D file types:

```typescript
// Extended binary types for 3D scenes
const BINARY_3D_EXTENSIONS = ['.glb', '.gltf', '.hdr', '.exr', '.basis', '.ktx2', '.wasm', '.bin', '.draco'];

// In the network interceptor:
page.on('request', (req) => {
  const url = req.url();
  const rt = req.resourceType();
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  
  if (
    ['stylesheet', 'script', 'image', 'font', 'media', 'other'].includes(rt) ||
    BINARY_3D_EXTENSIONS.includes(ext) ||
    rt === 'fetch' ||  // Three.js fetch calls
    rt === 'xhr'       // XMLHttpRequest asset loads
  ) {
    interceptedAssets.add(url);
  }
});
```

**WASM file handling** — Draco and Basis WASM decoders need special path rewriting inside JS:

```typescript
// After downloading JS bundles, rewrite WASM decoder paths
function rewriteWasmPaths(jsContent: string, assetMap: Map<string, string>): string {
  // Common patterns: 
  // draco_decoder.wasm, draco_wasm_wrapper.js
  // basis_transcoder.wasm, basis_transcoder.js
  for (const [originalUrl, localPath] of assetMap.entries()) {
    if (originalUrl.includes('.wasm') || originalUrl.includes('draco') || originalUrl.includes('basis')) {
      const filename = path.basename(originalUrl);
      jsContent = jsContent.replace(new RegExp(filename, 'g'), '../' + localPath);
    }
  }
  return jsContent;
}
```

#### [MODIFY] [dynamic-scraper.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/dynamic-scraper.ts)

Expand `interceptedAssets` collection to include `fetch` and `xhr` resource types (critical for Three.js GLTFLoader which uses fetch internally).

---

### Component 7: Svelte & Other Framework Support

#### [MODIFY] [cdn-injector.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/cdn-injector.ts)

**Add Svelte detection and re-init**:
- Svelte adds `svelte-HASH` class names to scoped elements
- Svelte transitions (`fade`, `slide`, `fly`) are injected as inline `<style>` on animation start
- Solution: detect `svelte-` class hash prefix and re-inject the transition CSS

```typescript
svelte: {
  name: "Svelte",
  // No CDN needed — Svelte compiles to vanilla JS
  // But we need to re-run transition animations via IntersectionObserver
  initScript: `
  // Svelte transition re-play
  if (typeof IntersectionObserver !== 'undefined') {
    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (!e.isIntersecting) return;
        // Find svelte-scoped elements and add animation class
        e.target.classList.add('svelte-entered');
        io.unobserve(e.target);
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('[class*="svelte-"]').forEach(function(el) {
      if (getComputedStyle(el).opacity === '0') io.observe(el);
    });
  }`
}
```

**Detection**:
```typescript
svelte: $('[class*="svelte-"]').length > 0 || html.includes('__svelte') || html.includes('sveltekit')
```

---

### Component 8: Mouse-Tracking & Cursor Effects

#### [MODIFY] [static-enhance.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/static-enhance.ts)

Many modern portfolios (rana-dolui, lumoslab) have cursor-following effects using CSS custom properties set via `mousemove`. Add to `buildEnhancementScript()`:

```javascript
// ── CURSOR TRACKING for parallax/spotlight effects ──
(function() {
  var ticking = false;
  document.addEventListener('mousemove', function(e) {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function() {
      var x = e.clientX / window.innerWidth;
      var y = e.clientY / window.innerHeight;
      document.documentElement.style.setProperty('--mouse-x', x.toFixed(4));
      document.documentElement.style.setProperty('--mouse-y', y.toFixed(4));
      document.documentElement.style.setProperty('--cursor-x', e.clientX + 'px');
      document.documentElement.style.setProperty('--cursor-y', e.clientY + 'px');
      ticking = false;
    });
  });
  
  // Custom cursor (if present)
  var cursor = document.querySelector('[class*="cursor"], #cursor, .cursor-dot, .cursor-ring');
  if (cursor) {
    document.addEventListener('mousemove', function(e) {
      cursor.style.transform = 'translate(' + e.clientX + 'px, ' + e.clientY + 'px)';
    });
  }
})();
```

---

### Component 9: Horizontal Scroll & Pinned Section Support

#### [MODIFY] [dynamic-scraper.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/dynamic-scraper.ts)

Add horizontal scroll triggering (for lumoslab.tech-style horizontal panels):

```typescript
async function triggerHorizontalScrollSections(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Find horizontal overflow containers
    document.querySelectorAll('[class*="horizontal"], [class*="h-scroll"], [style*="overflow-x"]').forEach(el => {
      const scrollWidth = el.scrollWidth - el.clientWidth;
      if (scrollWidth <= 0) return;
      
      // Sweep left-to-right
      for (let x = 0; x <= scrollWidth; x += 100) {
        el.scrollLeft = x;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      el.scrollLeft = 0;
    });
  });
}
```

Also add to `buildEnhancementScript()` — re-enable horizontal scroll interaction in cloned output:
```javascript
// Re-enable drag-to-scroll on horizontal containers
document.querySelectorAll('[class*="horizontal"], [class*="h-scroll"]').forEach(function(el) {
  var isDown = false, startX, scrollLeft;
  el.addEventListener('mousedown', function(e) { isDown=true; startX=e.pageX-el.offsetLeft; scrollLeft=el.scrollLeft; });
  el.addEventListener('mouseleave', function() { isDown=false; });
  el.addEventListener('mouseup', function() { isDown=false; });
  el.addEventListener('mousemove', function(e) {
    if (!isDown) return;
    e.preventDefault();
    el.scrollLeft = scrollLeft - (e.pageX - el.offsetLeft - startX) * 2;
  });
});
```

---

### Component 10: Script URL Rewriting in JS Bundles

#### [MODIFY] [asset-downloader.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/asset-downloader.ts)

**Critical for Three.js sites**: The JS bundle itself contains asset URLs as strings. We need to rewrite them too:

```typescript
function rewriteUrlsInJsBundle(jsContent: string, assetMap: Map<string, string>, baseUrl: string): string {
  let rewritten = jsContent;
  
  for (const [originalUrl, localPath] of assetMap.entries()) {
    // Match the URL as a quoted string in JS
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rewritten = rewritten
      .replace(new RegExp(`"${escaped}"`, 'g'), `"./${localPath}"`)
      .replace(new RegExp(`'${escaped}'`, 'g'), `'./${localPath}'`)
      .replace(new RegExp(`\`${escaped}\``, 'g'), `\`./${localPath}\``);
    
    // Also handle relative paths (/_next/static/...)
    try {
      const u = new URL(originalUrl);
      const relPath = u.pathname;
      const escRel = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rewritten = rewritten
        .replace(new RegExp(`"${escRel}"`, 'g'), `"./${localPath}"`)
        .replace(new RegExp(`'${escRel}'`, 'g'), `'./${localPath}'`);
    } catch {}
  }
  
  return rewritten;
}
```

Apply this to ALL `.js` bundle files after download.

---

### Component 11: tsParticles — Live Re-initialization

#### [MODIFY] [static-enhance.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/static-enhance.ts)

**rana-dolui.vercel.app** uses tsParticles for the animated background. Add re-init:

```javascript
// tsParticles re-initialization
(function() {
  if (typeof tsParticles === 'undefined' && typeof particlesJS === 'undefined') return;
  
  var particleContainer = document.querySelector('#tsparticles, #particles-js, [id*="particles"]');
  if (!particleContainer) return;
  
  // Find the original init config from inline scripts
  var scripts = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < scripts.length; i++) {
    var text = scripts[i].textContent || '';
    if (text.includes('tsParticles') || text.includes('particlesJS')) {
      try { new Function(text)(); } catch(e) {}
      break;
    }
  }
})();
```

#### [MODIFY] [cdn-injector.ts](file:///run/media/rana/DEV/code/Project/web_pro/ScrapeGen/apps/scraper/src/cdn-injector.ts)

Download tsParticles locally instead of CDN URL:
```typescript
tsParticles: {
  name: "tsParticles",
  localCdn: true,  // flag to download to ./assets/cdn/
  js: [`<script src="./assets/cdn/tsparticles.bundle.min.js"></script>`],
}
```

---

## Files Changed Summary

| File | Change Type | What Changes |
|---|---|---|
| `dynamic-scraper.ts` | MODIFY | Live CSS var harvest, Framer/GSAP element tagging, Three.js asset interception, XHR/fetch interception, horizontal scroll |
| `static-enhance.ts` | MODIFY | Brace-balanced var extractor, expanded theme detection, full `setTheme()`, mouse tracking, tsParticles re-init, GSAP ScrollTrigger.refresh() |
| `cdn-injector.ts` | MODIFY | Per-element Framer variants, GSAP DOM-driven re-init, Three.js local CDN, Svelte support, local download flag |
| `animation-engine.ts` | MODIFY | GSAP element tagging, clip-path/matrix3d capture, Houdini @property, computed transform capture |
| `animation-capture.ts` | MODIFY | Cross-origin CSS fetch fallback, computed animation API for lost keyframes |
| `asset-downloader.ts` | MODIFY | Binary 3D formats, WASM path rewriting, JS bundle URL rewriting |
| `threejs-cloner.ts` | **NEW** | Full Three.js scene preservation: fetch intercept, asset harvest, canvas preservation, local CDN download, serve.sh generation |
| `index.ts` | MODIFY | `--three`, `--wait-for-canvas`, `--no-canvas-replace` flags |

---

## Execution Order

```
1. Pre-navigation: inject fetch/XHR intercept + PAGE_INIT_SCRIPT
2. Navigate → wait for JS frameworks
3. Harvest: live CSS vars (both root AND dark, via getComputedStyle)
4. Trigger: scroll (vertical + horizontal), interactions, GSAP fast-forward
5. Tag: GSAP targets, Framer variants, pinned sections → data-scraper-* attributes
6. Freeze: strip start-state opacity/transform (but NOT canvas)
7. Capture: CSS keyframes (including cross-origin fetch fallback)
8. Collect: all intercepted asset URLs (including 3D binary assets)
9. Download: all assets locally (JS bundles, WASM, GLTF, HDR, fonts)
10. Rewrite: JS bundle string URLs, CSS urls, HTML src/href
11. Inject: CDN re-init scripts (local), per-element Framer CSS, GSAP re-init
12. Inject: enhancement script (theme, scroll, mouse, particles, tabs, mobile nav)
13. Save: index.html + serve.sh
```

---

## Verification Plan

### Test Suite
```bash
# 1. Portfolio with Framer Motion + theme toggle (rana-dolui)
bun run index.ts http://rana-dolui.vercel.app/ ./test_output/rana --dynamic --wait 5000 --capture-canvas

# 2. Svelte + Three.js hero (lumoslab)
bun run index.ts https://lumoslab.tech ./test_output/lumoslab --dynamic --three --wait 8000

# 3. Full 3D scene (Bruno Simon)
bun run index.ts https://bruno-simon.com ./test_output/bruno --dynamic --three --wait-for-canvas --wait 12000
    
# Then serve and check
cd ./test_output/rana && npx serve . -p 8080
```

### Verification Checklist (per site)
- ✅ Theme toggle: click → colors change smoothly, CSS vars update
- ✅ Scroll animations: elements animate in as you scroll (not preloaded all at once)
- ✅ Framer Motion: each element uses its own variant (scale, blur, slide, etc.)
- ✅ GSAP: timelines replay, ScrollTrigger pins work
- ✅ Three.js canvas: loads 3D scene, is interactive (OrbitControls, physics)
- ✅ tsParticles: particle background renders and responds to mouse
- ✅ Fonts: custom fonts render (not fallback system fonts)
- ✅ Images: all images load locally (no broken images)
- ✅ Mobile nav: hamburger button opens/closes menu
- ✅ Cursor: custom cursor follows mouse
- ✅ No external requests: everything served locally (check Network tab)
