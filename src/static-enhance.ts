/**
 * Universal offline enhancement for scraped pages.
 *
 * Injected into EVERY scraped page output. Provides:
 *   1. Scroll animation replay (IntersectionObserver-based)
 *   2. Full theme toggle with animated CSS variable transitions
 *      – supports next-themes, Tailwind dark, data-theme, data-color-mode, data-bs-theme
 *      – brace-balanced CSS var extractor (handles nested blocks)
 *      – live getComputedStyle values passed from scraper (via JSON)
 *   3. Hover effect preservation
 *   4. Mobile nav, tabs, accordions
 *   5. Smooth scrolling for anchor links + nav buttons
 *   6. Video autoplay
 *   7. Mouse/cursor tracking (--mouse-x/y CSS vars + custom cursor)
 *   8. Horizontal drag-to-scroll
 *   9. GSAP ScrollTrigger.refresh() on load
 *  10. tsParticles / particlesJS re-init
 *  11. Custom event dispatch (scroll, resize, mousemove) for lazy-init libraries
 */

import * as cheerio from "cheerio";

// ── Harvested CSS vars interface ──────────────────────────────────────────────

export interface CssVarHarvest {
  root: Record<string, string>;
  dark: Record<string, string>;
}

// ── Main injection entry point ───────────────────────────────────────────────

export function injectStaticEnhancement(
  $: ReturnType<typeof cheerio.load>,
  cssTexts: string[] = [],
  cssVarHarvest?: CssVarHarvest
): void {
  // ── 1. Remove tracking/analytics scripts ─────────────────────────────────
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    if (
      src.includes("/_vercel/insights") ||
      src.includes("/_vercel/speed-insights") ||
      src.includes("google-analytics") ||
      src.includes("googletagmanager") ||
      src.includes("clarity.ms") ||
      src.includes("hotjar") ||
      src.includes("segment.io") ||
      src.includes("mixpanel") ||
      src.includes("facebook.net") ||
      src.includes("twitter.com/widgets")
    ) {
      $(el).remove();
    }
  });

  $('link[rel="prefetch"], link[rel="dns-prefetch"]').remove();

  $("noscript").each((_, el) => {
    const content = $(el).html() ?? "";
    if (/gtm|google|pixel|tracking/i.test(content)) $(el).remove();
  });

  // ── 2. Resolve CSS variables ──────────────────────────────────────────────
  // Priority: live harvest from browser (most accurate) > parsed CSS files > inline styles
  let rootVars: Record<string, string> = {};
  let darkVars: Record<string, string> = {};

  if (cssVarHarvest) {
    // Use browser-harvested live values (set during dynamic scrape)
    rootVars = cssVarHarvest.root;
    darkVars = cssVarHarvest.dark;
  } else {
    // Fallback: parse from downloaded CSS files
    const inlineStyles = $("style").map((_, el) => $(el).html() ?? "").get();
    const allCssTexts = [...cssTexts, ...inlineStyles];
    rootVars = extractCssVarsBalanced(allCssTexts, ROOT_SELECTORS);
    darkVars = extractCssVarsBalanced(allCssTexts, DARK_SELECTORS);
  }

  // ── 3. Inject animation replay CSS ───────────────────────────────────────
  injectAnimationCSS($, darkVars);

  // ── 4. Inject main enhancement script ────────────────────────────────────
  const scriptContent = buildEnhancementScript(rootVars, darkVars);
  const scriptEl = $("<script></script>");
  scriptEl.attr("data-scraper-enhance", "true");
  scriptEl.text(scriptContent);
  $("body").append(scriptEl);
}

// ── Selector lists ───────────────────────────────────────────────────────────

const ROOT_SELECTORS = [
  ":root",
  "html",
  "body",
  '[data-theme="light"]',
  '[data-color-mode="light"]',
  ".light",
  "html.light",
];

const DARK_SELECTORS = [
  ".dark",
  "html.dark",
  "body.dark",
  '[data-theme="dark"]',
  '[data-color-mode="dark"]',
  '[data-mode="dark"]',
  '[data-bs-theme="dark"]',
  ".theme-dark",
  "html[data-theme='dark']",
  // media query block
  "@media (prefers-color-scheme: dark)",
];

// ── Brace-balanced CSS variable extractor ────────────────────────────────────

function extractCssVarsBalanced(
  cssTexts: string[],
  selectors: string[]
): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const css of cssTexts) {
    for (const selector of selectors) {
      // Handle @media (prefers-color-scheme: dark) specially
      const isMedia = selector.startsWith("@media");
      let searchIn = css;

      if (isMedia) {
        // Extract the content inside the @media block first
        const mediaIdx = css.indexOf(selector);
        if (mediaIdx === -1) continue;
        const openBrace = css.indexOf("{", mediaIdx);
        if (openBrace === -1) continue;
        let depth = 0, end = openBrace;
        while (end < css.length) {
          if (css[end] === "{") depth++;
          else if (css[end] === "}") { depth--; if (depth === 0) { end++; break; } }
          end++;
        }
        searchIn = css.slice(openBrace + 1, end - 1);
      }

      // Find all occurrences of this selector and extract vars
      let i = 0;
      while (i < searchIn.length) {
        const idx = searchIn.indexOf(selector, i);
        if (idx === -1) break;

        // Confirm it's followed only by whitespace/comments then {
        const afterSel = searchIn.slice(idx + selector.length);
        const betweenMatch = afterSel.match(/^[\s\n\r]*(?:\/\*[^*]*\*\/)?[\s\n\r]*\{/);
        if (!betweenMatch) { i = idx + selector.length; continue; }

        const openBrace = searchIn.indexOf("{", idx + selector.length);
        if (openBrace === -1) break;

        // Balance braces
        let depth = 0, end = openBrace;
        while (end < searchIn.length) {
          if (searchIn[end] === "{") depth++;
          else if (searchIn[end] === "}") { depth--; if (depth === 0) { end++; break; } }
          end++;
        }

        const block = searchIn.slice(openBrace + 1, end - 1);

        // Parse declarations (split by ; but respect nested parens)
        let decl = "";
        let parenDepth = 0;
        for (let ci = 0; ci < block.length; ci++) {
          const ch = block[ci];
          if (ch === "(") parenDepth++;
          else if (ch === ")") parenDepth--;
          else if (ch === ";" && parenDepth === 0) {
            // process decl
            const colonIdx = decl.indexOf(":");
            if (colonIdx >= 0) {
              const key = decl.slice(0, colonIdx).trim();
              const val = decl.slice(colonIdx + 1).trim();
              if (key.startsWith("--") && val) vars[key] = val;
            }
            decl = "";
            continue;
          }
          decl += ch;
        }

        i = end;
      }
    }
  }

  return vars;
}

// ── Animation CSS injection ──────────────────────────────────────────────────

function injectAnimationCSS(
  $: ReturnType<typeof cheerio.load>,
  darkVars: Record<string, string>
): void {
  const accentPrimary = darkVars["--accent-primary"] ?? darkVars["--primary"] ?? "#00ff88";
  const accentGlow = `${accentPrimary}55`;

  $("head").append(`<style data-scraper-anim="true">
/* ── Scroll-entry animation replay ──────────────────────────────────────── */
[data-scraper-will-animate] {
  opacity: 0;
  transform: translateY(18px);
  transition: opacity 0.6s ease, transform 0.6s ease;
}
[data-scraper-will-animate].scraper-animated {
  opacity: 1;
  transform: none;
}

/* ── Theme transition — smooth color changes on theme switch ─────────────── */
html.scraper-theme-transition,
html.scraper-theme-transition *,
html.scraper-theme-transition *::before,
html.scraper-theme-transition *::after {
  transition:
    background-color 0.3s ease,
    color 0.3s ease,
    border-color 0.3s ease,
    box-shadow 0.3s ease,
    fill 0.3s ease !important;
  transition-delay: 0s !important;
}

/* ── Cursor blink keyframe ───────────────────────────────────────────────── */
@keyframes scraper-blink-cursor {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}
.typed-cursor,
[class*="cursor-blink"],
[class*="typing-cursor"] {
  animation: scraper-blink-cursor 1s step-end infinite;
  display: inline-block;
}

/* ── Neon glow hover for accent buttons ─────────────────────────────────── */
[data-scraper-neon-btn]:hover {
  box-shadow: 0 0 16px ${accentGlow}, 0 0 40px ${accentGlow} !important;
}

/* ── Custom cursor element (common in portfolios) ────────────────────── */
[class*="cursor-dot"], [class*="cursor-ring"], #cursor, .cursor {
  pointer-events: none !important;
  transition: transform 0.08s linear !important;
}

/* ── hero-no-autoplay: Force-show all hero-reveal elements ─────────────── */
/* This is a built-in site fallback (antimetal.com pattern).               */
/* Added to <html> by the scraper. Overrides CSS :has() trigger.           */
html.hero-no-autoplay .hero-reveal {
  opacity: 1 !important;
  translate: none !important;
  scale: none !important;
  filter: none !important;
  transition: none !important;
}

/* ── Tailwind entry-state class overrides (belt-and-suspenders) ──────── */
/* In case Tailwind class stripping missed any elements during scrape.     */
/* Only targets elements with transition (animated), not static ones.      */
[class*="translate-y-"][style*="transition-delay"],
[class*="translate-x-"][style*="transition-delay"] {
  translate: none !important;
  transform: none !important;
}
</style>`);
}

// ── Main enhancement script ──────────────────────────────────────────────────

function buildEnhancementScript(
  rootVars: Record<string, string>,
  darkVars: Record<string, string>
): string {
  const rootVarsJson = JSON.stringify(rootVars);
  const darkVarsJson = JSON.stringify(darkVars);

  return `(function(){
'use strict';

var ROOT_VARS = ${rootVarsJson};
var DARK_VARS = ${darkVarsJson};

// ════════════════════════════════════════════════════════════════════════════
// 0. TAILWIND ANIMATION CLASS RECOVERY (runs immediately on load)
// Cleans up any residual opacity-0 / translate-y-* / blur-[*] classes that
// the scraper's page.evaluate() phase may have missed (e.g. SSR HTML that
// hadn't loaded styles yet, or elements inserted after freeze).
// ════════════════════════════════════════════════════════════════════════════

(function() {
  var STRIP = ['opacity-0','invisible','scale-x-0','scale-y-0','scale-0'];
  var PATS = [
    /\\btranslate-y-\\d+\\b/g,
    /\\b-translate-y-\\d+\\b/g,
    /\\btranslate-x-\\d+\\b/g,
    /\\b-translate-x-\\d+\\b/g,
    /\\bblur-\\[[\\d.]+(?:px|rem)\\]\\b/g,
    /\\bblur-(?:sm|md|lg|xl|2xl|3xl)\\b/g,
    /\\bscale-\\[[0-9.]+\\]\\b/g,
  ];
  try {
    var els = document.querySelectorAll(
      '[class*="opacity-0"],[class*="scale-x-0"],[class*="scale-y-0"],' +
      '[class*="translate-y-"],[class*="translate-x-"],[class*="blur-["],' +
      '.hero-reveal'
    );
    els.forEach(function(el) {
      var cls = typeof el.className === 'string' ? el.className : '';
      if (!cls) return;
      if (/\\b(?:group-hover|peer-hover|hover|focus)[:-]/.test(cls)) return;
      try {
        if (el.closest('[role="dialog"],[role="menu"],[role="tooltip"]')) return;
        if (el.closest('[data-state="closed"],[data-radix-popper-content-wrapper]')) return;
      } catch(e) {}
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none') return;
      var hasTrans = cs.transitionDuration && cs.transitionDuration !== '0s';
      var isMarked = /\\bhero-reveal\\b/.test(cls) || /\\bdelay-\\d+\\b/.test(cls);
      if (!hasTrans && !isMarked) return;
      var newCls = cls;
      STRIP.forEach(function(c) { el.classList.remove(c); });
      PATS.forEach(function(p) { newCls = newCls.replace(p, ' '); p.lastIndex = 0; });
      el.className = newCls.replace(/\\s+/g, ' ').trim();
    });
  } catch(e) {}
})();

// ════════════════════════════════════════════════════════════════════════════
// 1. SCROLL ANIMATION REPLAY
// ════════════════════════════════════════════════════════════════════════════

if (typeof IntersectionObserver !== 'undefined') {
  // AOS
  var aosIO = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('aos-animate');
      aosIO.unobserve(entry.target);
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });
  document.querySelectorAll('[data-aos]:not(.aos-animate)').forEach(function(el) { aosIO.observe(el); });

  // WOW
  var wowIO = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('animated');
      entry.target.style.visibility = 'visible';
      wowIO.unobserve(entry.target);
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.wow:not(.animated)').forEach(function(el) { wowIO.observe(el); });

  // SAL
  var salIO = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.setAttribute('data-sal-entered', '');
      entry.target.classList.add('sal-animate');
      salIO.unobserve(entry.target);
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('[data-sal]:not([data-sal-entered])').forEach(function(el) { salIO.observe(el); });

  // Custom scraper will-animate
  var customIO = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('scraper-animated');
      customIO.unobserve(entry.target);
    });
  }, { threshold: 0.05, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('[data-scraper-will-animate]').forEach(function(el) { customIO.observe(el); });
}

// ════════════════════════════════════════════════════════════════════════════
// 2. THEME TOGGLE — Full CSS variable swap + all attribute syncs
// ════════════════════════════════════════════════════════════════════════════

var html = document.documentElement;
var body = document.body || html;

function isDark() {
  return html.classList.contains('dark') ||
    body.classList.contains('dark') ||
    html.getAttribute('data-theme') === 'dark' ||
    html.getAttribute('data-color-mode') === 'dark' ||
    html.getAttribute('data-mode') === 'dark' ||
    body.getAttribute('data-bs-theme') === 'dark';
}

function applyThemeVars(vars) {
  Object.keys(vars).forEach(function(key) {
    if (vars[key]) html.style.setProperty(key, vars[key]);
  });
}

function setTheme(dark) {
  // Smooth transition
  html.classList.add('scraper-theme-transition');

  var val = dark ? 'dark' : 'light';

  // ── Class-based (Tailwind, shadcn/ui, next-themes default) ──────────────
  html.classList.toggle('dark', dark);
  html.classList.toggle('light', !dark);
  body.classList.toggle('dark', dark);
  body.classList.toggle('light', !dark);

  // ── Attribute-based (next-themes, custom) ────────────────────────────────
  html.setAttribute('data-theme', val);
  html.setAttribute('data-color-mode', val);
  html.setAttribute('data-mode', val);
  html.setAttribute('color-scheme', dark ? 'dark' : 'normal');
  body.setAttribute('data-theme', val);
  body.setAttribute('data-bs-theme', val);          // Bootstrap 5
  body.setAttribute('data-color-scheme', val);      // custom

  // ── CSS color-scheme ─────────────────────────────────────────────────────
  html.style.colorScheme = dark ? 'dark' : 'light';

  // ── CSS variable injection ────────────────────────────────────────────────
  applyThemeVars(dark ? DARK_VARS : ROOT_VARS);

  // ── Persist ───────────────────────────────────────────────────────────────
  try { localStorage.setItem('theme', val); } catch(e) {}

  // ── Notify canvas renderers + theme-aware components ─────────────────────
  // Dispatch both a standard resize (nudges canvas re-init) and a
  // custom 'themechange' event that our canvas animation script listens to.
  try {
    window.dispatchEvent(new CustomEvent('themechange', { detail: { dark: dark, theme: val } }));
    window.dispatchEvent(new Event('resize'));
    document.dispatchEvent(new Event('visibilitychange'));
  } catch(e) {}

  setTimeout(function() { html.classList.remove('scraper-theme-transition'); }, 350);
}

// Restore saved theme
try {
  var saved = localStorage.getItem('theme');
  if (saved) {
    setTheme(saved === 'dark');
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme(true);
  }
} catch(e) {}

// Live system theme change
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
    try { if (!localStorage.getItem('theme')) setTheme(e.matches); } catch(err) {}
  });
} catch(e) {}

// ── Theme toggle button detection ─────────────────────────────────────────
// Universal heuristics — catches next-themes, shadcn, custom, icon-only buttons
function findThemeToggle() {
  var candidates = document.querySelectorAll('button, [role="button"], [tabindex]');
  for (var i = 0; i < candidates.length; i++) {
    var btn = candidates[i];

    // 1. aria-label / title match
    var label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.title || '')).toLowerCase();
    if (/theme|dark.?mode|light.?mode|color.?scheme|toggle.?mode|switch.?mode|appearance/i.test(label)) {
      return btn;
    }

    // 2. data attribute (next-themes, custom)
    if (btn.hasAttribute('data-theme-toggle') || btn.hasAttribute('data-color-toggle')) return btn;

    // 3. Class/ID match
    var cls = (btn.getAttribute('class') || '').toLowerCase();
    var id  = (btn.getAttribute('id') || '').toLowerCase();
    if (/theme.toggle|dark.toggle|light.toggle|mode.toggle|color.switch/i.test(cls + id)) return btn;

    // 4. SVG icon analysis — moon/sun path signatures
    var svgs = btn.querySelectorAll('svg');
    if (svgs.length > 0 && svgs.length <= 3) {
      var allPathInfo = '';
      svgs.forEach(function(svg) {
        svg.querySelectorAll('path, circle, line').forEach(function(el) {
          allPathInfo += (el.getAttribute('d') || '') + (el.getAttribute('class') || '');
        });
        allPathInfo += (svg.getAttribute('class') || '');
      });
      var lowerPath = allPathInfo.toLowerCase();
      // Moon pattern: arc + top-right position, Sun: many M commands or radial lines
      if (/lucide-sun|lucide-moon|fa-sun|fa-moon|bi-sun|bi-moon|icon-sun|icon-moon|ri-sun|ri-moon/i.test(lowerPath)) {
        return btn;
      }
      // SVG contains moon shape (complex arc)
      if (/m\s*2[01]/.test(allPathInfo) && allPathInfo.includes('A')) return btn;
    }

    // 5. Button text match
    var text = (btn.textContent || '').trim().toLowerCase();
    if (/^(dark|light|theme|mode)$/.test(text)) return btn;
  }
  return null;
}

var themeBtn = findThemeToggle();
if (themeBtn) {
  themeBtn.style.cursor = 'pointer';
  themeBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    setTheme(!isDark());
  }, true);
}

// ── Wire aria-label="Switch to light/dark/system theme" buttons ──────────
document.querySelectorAll('button[aria-label]').forEach(function(btn) {
  var label = (btn.getAttribute('aria-label') || '').toLowerCase();
  if (label.includes('switch to light')) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); setTheme(false); }, true);
  } else if (label.includes('switch to dark')) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); setTheme(true); }, true);
  } else if (label.includes('switch to system')) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }, true);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. MOUSE / CURSOR TRACKING
// ════════════════════════════════════════════════════════════════════════════

(function() {
  var ticking = false;
  document.addEventListener('mousemove', function(e) {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function() {
      var xFrac = (e.clientX / window.innerWidth).toFixed(4);
      var yFrac = (e.clientY / window.innerHeight).toFixed(4);
      html.style.setProperty('--mouse-x', xFrac);
      html.style.setProperty('--mouse-y', yFrac);
      html.style.setProperty('--cursor-x', e.clientX + 'px');
      html.style.setProperty('--cursor-y', e.clientY + 'px');
      ticking = false;
    });
  }, { passive: true });

  // Custom cursor element (common in portfolios)
  var cursor = document.querySelector(
    '[class*="cursor-dot"], [class*="cursor-ring"], ' +
    '[class*="custom-cursor"], #cursor, .cursor, [data-cursor]'
  );
  if (cursor) {
    var cx = 0, cy = 0;
    document.addEventListener('mousemove', function(e) {
      cx = e.clientX; cy = e.clientY;
      requestAnimationFrame(function() {
        cursor.style.transform = 'translate(' + cx + 'px, ' + cy + 'px)';
      });
    }, { passive: true });
  }
})();

// ════════════════════════════════════════════════════════════════════════════
// 4. SMOOTH SCROLL for anchor links AND nav buttons
// ════════════════════════════════════════════════════════════════════════════

document.querySelectorAll('a[href^="#"]').forEach(function(a) {
  a.addEventListener('click', function(e) {
    var href = a.getAttribute('href');
    if (!href || href === '#') return;
    try {
      var target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch(ex) {}
  });
});

// React SPA nav: match button text to section ids
var sectionMap = {};
document.querySelectorAll('section[id], [id]').forEach(function(el) {
  sectionMap[el.id.toLowerCase()] = el;
});
document.querySelectorAll('h1, h2, h3').forEach(function(h) {
  var txt = (h.textContent || '').trim().toLowerCase().replace(/\\s+/g, '-');
  sectionMap[txt] = h;
});

document.querySelectorAll('nav button, header button, nav a, header a').forEach(function(btn) {
  var text = (btn.textContent || '').trim().toLowerCase();
  if (!text || text.length > 24) return;
  if (/^(dark|light|theme|menu|close)$/.test(text)) return;
  var sectionKey = text.replace(/\\s+/g, '-');
  var target = sectionMap[sectionKey] || sectionMap[text];
  if (!target) {
    for (var key in sectionMap) {
      if (key.indexOf(sectionKey) === 0 || sectionKey.indexOf(key) === 0) {
        target = sectionMap[key]; break;
      }
    }
  }
  if (target) {
    (function(t) {
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    })(target);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. MOBILE NAV TOGGLE
// ════════════════════════════════════════════════════════════════════════════

(function() {
  var menuBtn = null;
  var btns = document.querySelectorAll('button, [role="button"]');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    var lbl = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
    if (/menu|nav|hamburger|toggle|open.?menu|close.?menu/i.test(lbl)) { menuBtn = b; break; }
    var s = b.querySelector('svg');
    if (s && /(menu|hamburger|bars|x-mark|close)/i.test((s.getAttribute('class') || '') + s.innerHTML)) {
      menuBtn = b; break;
    }
  }
  if (!menuBtn) return;

  var container = menuBtn.closest('nav') || menuBtn.closest('header') || document.querySelector('header');
  var panel = container ? container.querySelector(
    '[class*="mobile"], [class*="drawer"], [class*="sidebar"], ' +
    '[id*="mobile-menu"], [id*="nav-panel"], [data-mobile-menu], [aria-hidden="true"]'
  ) : null;

  if (!panel) return;

  var isOpen = panel.getAttribute('aria-hidden') === 'false' || panel.style.display !== 'none';

  menuBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    isOpen = !isOpen;
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    panel.style.display = isOpen ? '' : 'none';
    if (isOpen) panel.removeAttribute('hidden');
    menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// 6. TAB NAVIGATION
// ════════════════════════════════════════════════════════════════════════════

document.querySelectorAll('[role="tablist"]').forEach(function(tablist) {
  var tabs = tablist.querySelectorAll('[role="tab"]');
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      tabs.forEach(function(t) {
        t.setAttribute('aria-selected', 'false');
        t.classList.remove('active', 'is-active', 'selected', 'tab-active');
      });
      tab.setAttribute('aria-selected', 'true');
      tab.classList.add('active');

      var controls = tab.getAttribute('aria-controls');
      if (controls) {
        document.querySelectorAll('[role="tabpanel"]').forEach(function(p) {
          p.setAttribute('hidden', '');
          p.style.display = 'none';
        });
        var panel = document.getElementById(controls);
        if (panel) { panel.removeAttribute('hidden'); panel.style.display = ''; }
      }
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. ACCORDION
// ════════════════════════════════════════════════════════════════════════════

document.querySelectorAll('[role="button"][aria-expanded], details summary').forEach(function(btn) {
  btn.addEventListener('click', function() {
    if (btn.tagName === 'SUMMARY') return; // native
    var expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    var controls = btn.getAttribute('aria-controls');
    if (controls) {
      var panel = document.getElementById(controls);
      if (panel) { panel.hidden = expanded; panel.style.display = expanded ? 'none' : ''; }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. VIDEO AUTOPLAY
// ════════════════════════════════════════════════════════════════════════════

document.querySelectorAll('video').forEach(function(v) {
  v.muted = true;
  v.setAttribute('muted', '');
  v.setAttribute('playsinline', '');
  if (v.hasAttribute('autoplay') || v.dataset.autoplay) {
    var p = v.play();
    if (p && p.catch) p.catch(function(){});
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 9. HORIZONTAL DRAG-TO-SCROLL
// ════════════════════════════════════════════════════════════════════════════

document.querySelectorAll(
  '[class*="horizontal"], [class*="h-scroll"], [class*="carousel"], ' +
  '[class*="slider"], [class*="scroll-x"]'
).forEach(function(el) {
  var cs = window.getComputedStyle(el);
  if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') return;

  var isDown = false, startX = 0, scrollLeft = 0;
  el.addEventListener('mousedown', function(e) {
    isDown = true;
    startX = e.pageX - el.offsetLeft;
    scrollLeft = el.scrollLeft;
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('mouseleave', function() { isDown = false; el.style.cursor = ''; });
  el.addEventListener('mouseup',    function() { isDown = false; el.style.cursor = ''; });
  el.addEventListener('mousemove',  function(e) {
    if (!isDown) return;
    e.preventDefault();
    var x = e.pageX - el.offsetLeft;
    el.scrollLeft = scrollLeft - (x - startX) * 1.5;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. GSAP SCROLL TRIGGER REFRESH
// ════════════════════════════════════════════════════════════════════════════

window.addEventListener('load', function() {
  try {
    if (typeof ScrollTrigger !== 'undefined') {
      ScrollTrigger.refresh();
    }
  } catch(e) {}

  // Dispatch resize + scroll to trigger lazy-init listeners
  try {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('scroll'));
  } catch(e) {}
});

// ════════════════════════════════════════════════════════════════════════════
// 11b. FRAMER MOTION whileInView — scroll-entry replay
// ════════════════════════════════════════════════════════════════════════════
// Framer Motion's whileInView animations won't replay offline because React
// doesn't hydrate. We re-implement with IntersectionObserver.
// We use the data-scraper-fm-type attribute tagged by the animation engine.

(function() {
  if (typeof IntersectionObserver === 'undefined') return;

  // Build inline style for the 'hidden' (before-reveal) state
  function buildFromStyle(fmType) {
    var parts = [];
    if (fmType.hasOpacity)    parts.push('opacity:0');
    if (fmType.hasTranslateY) parts.push('transform:translateY(32px)');
    else if (fmType.hasTranslateX) parts.push('transform:translateX(-32px)');
    if (fmType.hasScale)      parts.push('transform:scale(0.95)');
    if (fmType.hasBlur)       parts.push('filter:blur(8px)');
    return parts.join(';');
  }

  // Build transition string
  function buildTransition(fmType) {
    var dur  = parseFloat(fmType.duration || '0.5');
    var del  = parseFloat(fmType.delay || '0');
    return 'opacity ' + dur + 's ease ' + del + 's,' +
           'transform ' + dur + 's cubic-bezier(0.16,1,0.3,1) ' + del + 's,' +
           'filter ' + dur + 's ease ' + del + 's';
  }

  var fmEls = document.querySelectorAll('[data-scraper-fm-type]');
  if (!fmEls.length) return;

  var fmIO = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      // Reveal: clear the from-styles, let transition play
      el.style.removeProperty('opacity');
      el.style.removeProperty('transform');
      el.style.removeProperty('filter');
      el.style.removeProperty('clip-path');
      fmIO.unobserve(el);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -48px 0px' });

  fmEls.forEach(function(el) {
    try {
      var fmType = JSON.parse(el.getAttribute('data-scraper-fm-type') || '{}');
      var fromStyle = buildFromStyle(fmType);
      if (!fromStyle) return; // nothing to animate
      // Apply from-state and transition
      var existingStyle = el.getAttribute('style') || '';
      el.setAttribute('style', existingStyle + ';' + fromStyle + ';transition:' + buildTransition(fmType));
      fmIO.observe(el);
    } catch(e) {}
  });
})();

// ════════════════════════════════════════════════════════════════════════════
// 12b. CANVAS BACKGROUND ANIMATION
// ════════════════════════════════════════════════════════════════════════════
// Recreates the hero section canvas animation (starfield in dark mode,
// sun-glow particle system in light mode) using harvested CSS vars.
// Works without React hydration by reading --background / --primary CSS vars.

(function() {
  // Find the hero background canvas (absolute inset-0 in first section)
  var heroSection = document.getElementById('home') ||
                   document.querySelector('section:first-of-type') ||
                   document.querySelector('header');
  if (!heroSection) return;

  var canvas = heroSection.querySelector('canvas');
  if (!canvas) {
    // Try global first canvas
    canvas = document.querySelector('canvas.absolute, canvas[class*="inset"]');
  }
  if (!canvas) return;

  var ctx = null;
  try { ctx = canvas.getContext('2d'); } catch(e) { return; }
  if (!ctx) return;

  // Prevent the original (now broken) React canvas from double-drawing
  canvas.setAttribute('data-scraper-canvas-managed', 'true');

  var W = 0, H = 0;
  var animId = null;
  var particles = [];
  var shootingStars = [];

  function getCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hexToRgb(hex) {
    // Support: #rrggbb, #rgb, oklch(...), hsl(...), rgb(...)
    hex = hex.trim();
    if (hex.startsWith('#')) {
      var big = parseInt(hex.slice(1).length === 3
        ? hex.slice(1).split('').map(function(c){return c+c;}).join('')
        : hex.slice(1), 16);
      return [(big >> 16) & 255, (big >> 8) & 255, big & 255];
    }
    // Fallback to a temp element approach
    try {
      var tmp = document.createElement('div');
      tmp.style.color = hex;
      document.body.appendChild(tmp);
      var cs = getComputedStyle(tmp).color;
      document.body.removeChild(tmp);
      var m = cs.match(/\d+/g);
      if (m) return [parseInt(m[0]), parseInt(m[1]), parseInt(m[2])];
    } catch(e) {}
    return [200, 200, 200];
  }

  function isDarkMode() {
    return document.documentElement.classList.contains('dark') ||
           document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function resize() {
    W = canvas.parentElement ? canvas.parentElement.offsetWidth : window.innerWidth;
    H = canvas.parentElement ? canvas.parentElement.offsetHeight : window.innerHeight;
    if (W === 0) W = window.innerWidth;
    if (H === 0) H = window.innerHeight;
    canvas.width  = W;
    canvas.height = H;
    initParticles();
  }

  function initParticles() {
    particles = [];
    var count = Math.min(Math.floor((W * H) / 14000), 80);
    for (var i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.4 + 0.3,
        alpha: Math.random() * 0.6 + 0.2,
        speed: Math.random() * 0.15 + 0.02,
        drift: (Math.random() - 0.5) * 0.06,
        twinkle: Math.random() * Math.PI * 2,
      });
    }
    shootingStars = [];
  }

  function spawnShootingStar() {
    if (Math.random() > 0.004) return;
    shootingStars.push({
      x: Math.random() * W * 0.7,
      y: Math.random() * H * 0.4,
      len: Math.random() * 120 + 60,
      speed: Math.random() * 6 + 4,
      alpha: 1,
      angle: Math.PI / 4 + (Math.random() - 0.5) * 0.3,
      life: 1,
    });
  }

  function drawDark(accentRgb) {
    ctx.clearRect(0, 0, W, H);

    // Subtle radial gradient vignette
    var grad = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    grad.addColorStop(0, 'rgba(' + accentRgb.join(',') + ',0.04)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Stars
    particles.forEach(function(p) {
      p.twinkle += 0.018;
      var alpha = p.alpha * (0.7 + 0.3 * Math.sin(p.twinkle));
      p.y -= p.speed;
      p.x += p.drift;
      if (p.y < -2) { p.y = H + 2; p.x = Math.random() * W; }
      if (p.x < -2) p.x = W + 2;
      if (p.x > W + 2) p.x = -2;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.fill();
    });

    // Shooting stars
    spawnShootingStar();
    shootingStars = shootingStars.filter(function(s) {
      s.x += Math.cos(s.angle) * s.speed;
      s.y += Math.sin(s.angle) * s.speed;
      s.life -= 0.018;
      if (s.life <= 0) return false;

      var tailX = s.x - Math.cos(s.angle) * s.len;
      var tailY = s.y - Math.sin(s.angle) * s.len;
      var g = ctx.createLinearGradient(tailX, tailY, s.x, s.y);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(255,255,255,' + (s.life * 0.9) + ')');
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(s.x, s.y);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      return true;
    });
  }

  function drawLight(accentRgb) {
    ctx.clearRect(0, 0, W, H);

    // Warm sun-glow in top-right
    var sg = ctx.createRadialGradient(W * 0.85, H * 0.1, 0, W * 0.85, H * 0.1, W * 0.55);
    sg.addColorStop(0, 'rgba(' + accentRgb.join(',') + ',0.12)');
    sg.addColorStop(0.5, 'rgba(' + accentRgb.join(',') + ',0.04)');
    sg.addColorStop(1, 'rgba(' + accentRgb.join(',') + ',0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, W, H);

    // Subtle floating dust particles
    particles.forEach(function(p) {
      p.twinkle += 0.012;
      var alpha = p.alpha * 0.25 * (0.7 + 0.3 * Math.sin(p.twinkle));
      p.y -= p.speed * 0.4;
      p.x += p.drift;
      if (p.y < -2) { p.y = H + 2; p.x = Math.random() * W; }
      if (p.x < -2) p.x = W + 2;
      if (p.x > W + 2) p.x = -2;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + accentRgb.join(',') + ',' + alpha + ')';
      ctx.fill();
    });
  }

  var dark = isDarkMode();
  var accentRgb = [0, 255, 136]; // fallback green

  function getAccentRgb() {
    var dark = isDarkMode();
    var varName = dark ? '--primary' : '--primary';
    var primaryVar = getCssVar(varName) || getCssVar('--accent-primary') || getCssVar('--color-primary');
    if (primaryVar) {
      var rgb = hexToRgb(primaryVar);
      if (rgb) return rgb;
    }
    return dark ? [0, 255, 136] : [249, 115, 22]; // green/orange defaults
  }

  function draw() {
    var isDark = isDarkMode();
    if (isDark) drawDark(accentRgb);
    else        drawLight(accentRgb);
    animId = requestAnimationFrame(draw);
  }

  function init() {
    if (animId) cancelAnimationFrame(animId);
    accentRgb = getAccentRgb();
    resize();
    draw();
  }

  // Listen for theme changes (fired by setTheme)
  window.addEventListener('themechange', function() {
    if (animId) cancelAnimationFrame(animId);
    accentRgb = getAccentRgb();
    initParticles();
    draw();
  });

  window.addEventListener('resize', function() {
    resize();
  }, { passive: true });

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to let CSS vars resolve
    setTimeout(init, 60);
  }
})();

// ════════════════════════════════════════════════════════════════════════════
// 11. PARTICLES RE-INIT
// ════════════════════════════════════════════════════════════════════════════

window.addEventListener('load', function() {
  try {
    var scripts = document.querySelectorAll('script:not([src])');

    // tsParticles
    if (typeof tsParticles !== 'undefined') {
      for (var i = 0; i < scripts.length; i++) {
        var t = scripts[i].textContent || '';
        if (t.includes('tsParticles') || t.includes('tsparticles')) {
          try { (new Function(t))(); break; } catch(e) {}
        }
      }
    }

    // particlesJS
    if (typeof particlesJS !== 'undefined' && document.querySelector('#particles-js')) {
      for (var i = 0; i < scripts.length; i++) {
        var t = scripts[i].textContent || '';
        if (t.includes('particlesJS') && t.includes('particles-js')) {
          try { (new Function(t))(); break; } catch(e) {}
        }
      }
    }
  } catch(e) {}
});

// ════════════════════════════════════════════════════════════════════════════
// 12. CANVAS PARTICLE SYSTEMS — re-init from preserved script
// ════════════════════════════════════════════════════════════════════════════

try {
  if (window.particlesJS && document.querySelector('#particles-js')) {
    var scripts = document.querySelectorAll('script:not([src])');
    for (var si = 0; si < scripts.length; si++) {
      var stext = scripts[si].textContent || '';
      if (stext.indexOf('particlesJS') !== -1 && stext.indexOf('particles-js') !== -1) {
        var fn = new Function(stext);
        try { fn(); } catch(e) {}
        break;
      }
    }
  }
} catch(e) {}

})();`;
}
