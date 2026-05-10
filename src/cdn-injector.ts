/**
 * CDN Injector — injects animation framework CDN scripts/styles
 * into the scraped output HTML.
 *
 * Strategy: download CDN files LOCALLY (to ./assets/cdn/) so the cloned
 * site works fully offline. Only Three.js modules use importmap.
 *
 * Supported frameworks:
 *   • AOS (Animate On Scroll)
 *   • GSAP + ScrollTrigger (with DOM-driven re-init)
 *   • Animate.css
 *   • WOW.js
 *   • SAL (Scroll Animation Library)
 *   • ScrollReveal
 *   • Splitting.js
 *   • Lottie / bodymovin
 *   • Typed.js
 *   • Swiper
 *   • Motion One
 *   • Anime.js
 *   • particles.js / tsParticles
 *   • Svelte (transition replay via IntersectionObserver)
 *   • Framer Motion (per-element CSS variant fallback)
 */

import * as cheerio from "cheerio";

// ── CDN definitions ─────────────────────────────────────────────────────────

interface CdnEntry {
  /** CSS link tags to inject in <head> */
  css?: string[];
  /** JS script tags to inject before </body> */
  js?: string[];
  /** Inline init script to run after the JS loads */
  initScript?: string;
  /** Description for logging */
  name: string;
  /** If true, these files should be downloaded locally to ./assets/cdn/ */
  localCdn?: boolean;
  /** Remote URLs for local download (parallel to js[] scrArr, same order) */
  downloadUrls?: string[];
}

const CDN_REGISTRY: Record<string, CdnEntry> = {

  aos: {
    name: "AOS (Animate On Scroll)",
    localCdn: true,
    css: [
      `<link rel="stylesheet" href="./assets/cdn/aos.css">`,
    ],
    js: [
      `<script src="./assets/cdn/aos.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/aos@2.3.4/dist/aos.css",
      "https://cdn.jsdelivr.net/npm/aos@2.3.4/dist/aos.js",
    ],
    initScript: `
if (typeof AOS !== 'undefined') {
  AOS.init({
    duration: 800,
    once: false,
    mirror: false,
    offset: 60,
    easing: 'ease-out-quart',
  });
}`,
  },

  gsap: {
    name: "GSAP",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/gsap.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js",
    ],
  },

  gsapScrollTrigger: {
    name: "GSAP ScrollTrigger",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/ScrollTrigger.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js",
    ],
    initScript: `
if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);

  // Restore scroll-position-based animations from tagged elements
  document.querySelectorAll('[data-gsap-from]').forEach(function(el) {
    try {
      var from = JSON.parse(el.getAttribute('data-gsap-from') || '{}');
      var to   = JSON.parse(el.getAttribute('data-gsap-to')   || '{}');
      if (!from || !to) return;

      // Map opacity + y from captured data
      var fromProps = { opacity: 0, y: from.y || 40, immediateRender: true };
      var toProps = {
        opacity: parseFloat(to.opacity || '1'),
        y: 0,
        duration: 0.8,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: el,
          start: 'top 88%',
          end: 'bottom 12%',
          toggleActions: 'play none none reverse',
        }
      };

      gsap.fromTo(el, fromProps, toProps);
    } catch(e) {}
  });

  // Restore pinned sections
  document.querySelectorAll('[data-gsap-pin]').forEach(function(el) {
    try {
      ScrollTrigger.create({
        trigger: el,
        pin: true,
        start: 'top top',
        end: '+=' + (el.getAttribute('data-gsap-pin-length') || '300%'),
        pinSpacing: true,
      });
    } catch(e) {}
  });

  ScrollTrigger.refresh();
}`,
  },

  animateCss: {
    name: "Animate.css",
    localCdn: true,
    css: [
      `<link rel="stylesheet" href="./assets/cdn/animate.min.css">`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/animate.css@4.1.1/animate.min.css",
    ],
  },

  wowJs: {
    name: "WOW.js",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/wow.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/wowjs@1.1.3/dist/wow.min.js",
    ],
    initScript: `
if (typeof WOW !== 'undefined') {
  new WOW({ live: false, mobile: true }).init();
}`,
  },

  sal: {
    name: "SAL (Scroll Animation Library)",
    localCdn: true,
    css: [
      `<link rel="stylesheet" href="./assets/cdn/sal.css">`,
    ],
    js: [
      `<script src="./assets/cdn/sal.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/sal.js@0.8.5/dist/sal.css",
      "https://cdn.jsdelivr.net/npm/sal.js@0.8.5/dist/sal.js",
    ],
    initScript: `
if (typeof sal !== 'undefined') {
  sal({ threshold: 0.1, once: false });
}`,
  },

  scrollReveal: {
    name: "ScrollReveal",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/scrollreveal.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/scrollreveal@4.0.9/dist/scrollreveal.min.js",
    ],
    initScript: `
if (typeof ScrollReveal !== 'undefined') {
  // Re-init with minimal movement so already-entered elements stay visible
  ScrollReveal({ reset: false, distance: '20px', duration: 700, easing: 'ease-out' });
}`,
  },

  splitting: {
    name: "Splitting.js",
    localCdn: true,
    css: [
      `<link rel="stylesheet" href="./assets/cdn/splitting.css">`,
      `<link rel="stylesheet" href="./assets/cdn/splitting-cells.css">`,
    ],
    js: [
      `<script src="./assets/cdn/splitting.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/splitting@1.0.6/dist/splitting.css",
      "https://cdn.jsdelivr.net/npm/splitting@1.0.6/dist/splitting-cells.css",
      "https://cdn.jsdelivr.net/npm/splitting@1.0.6/dist/splitting.min.js",
    ],
    initScript: `
if (typeof Splitting !== 'undefined') {
  Splitting();
}`,
  },

  lottie: {
    name: "Lottie / bodymovin",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/lottie.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js",
    ],
  },

  dotlottie: {
    name: "DotLottie Player",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/dotlottie-player.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/@dotlottie/player-component@2.7.12/dist/dotlottie-player.js",
    ],
    initScript: `
// DotLottie player web component re-initialization
(function() {
  if (typeof customElements === 'undefined') return;
  // The web component auto-registers via the script above.
  // Re-render any dotlottie-player elements that have a src attribute.
  document.querySelectorAll('dotlottie-player[src]').forEach(function(el) {
    try {
      var src = el.getAttribute('src');
      if (src) {
        // Force re-render by toggling autoplay
        el.setAttribute('autoplay', '');
        el.setAttribute('loop', '');
        if (typeof el.load === 'function') el.load(src);
        else if (typeof el.play === 'function') { el.load && el.load(src); el.play(); }
      }
    } catch(e) {}
  });
})();`,
  },

  typed: {
    name: "Typed.js",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/typed.umd.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/typed.js@2.1.0/dist/typed.umd.js",
    ],
  },

  swiper: {
    name: "Swiper",
    localCdn: true,
    css: [
      `<link rel="stylesheet" href="./assets/cdn/swiper-bundle.min.css">`,
    ],
    js: [
      `<script src="./assets/cdn/swiper-bundle.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css",
      "https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js",
    ],
    initScript: `
if (typeof Swiper !== 'undefined') {
  document.querySelectorAll('.swiper:not(.swiper-initialized)').forEach(function(el) {
    new Swiper(el, {
      loop: true,
      autoplay: { delay: 3500, disableOnInteraction: false, pauseOnMouseEnter: true },
      pagination: {
        el: el.querySelector('.swiper-pagination'),
        clickable: true,
      },
      navigation: {
        nextEl: el.querySelector('.swiper-button-next'),
        prevEl: el.querySelector('.swiper-button-prev'),
      },
      keyboard: { enabled: true },
      grabCursor: true,
    });
  });
}`,
  },

  animeJs: {
    name: "Anime.js",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/anime.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js",
    ],
  },

  motionOne: {
    name: "Motion One",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/motion.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/motion@10.18.0/dist/motion.js",
    ],
  },

  tsParticles: {
    name: "tsParticles",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/tsparticles.bundle.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/tsparticles@2.12.0/tsparticles.bundle.min.js",
    ],
    initScript: `
// Re-initialize tsParticles from captured config in inline scripts
(function() {
  if (typeof tsParticles === 'undefined') return;
  var scripts = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < scripts.length; i++) {
    var text = scripts[i].textContent || '';
    if (text.includes('tsParticles') || text.includes('tsparticles')) {
      try { (new Function(text))(); break; } catch(e) {}
    }
  }
})();`,
  },

  particlesJs: {
    name: "particles.js",
    localCdn: true,
    js: [
      `<script src="./assets/cdn/particles.min.js"></script>`,
    ],
    downloadUrls: [
      "https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js",
    ],
    initScript: `
(function() {
  if (typeof particlesJS === 'undefined') return;
  var scripts = document.querySelectorAll('script:not([src])');
  for (var i = 0; i < scripts.length; i++) {
    var text = scripts[i].textContent || '';
    if (text.includes('particlesJS') && text.includes('particles-js')) {
      try { (new Function(text))(); break; } catch(e) {}
    }
  }
})();`,
  },

};

// ── Detection helpers ────────────────────────────────────────────────────────

export interface DetectedFrameworks {
  aos: boolean;
  gsap: boolean;
  gsapScrollTrigger: boolean;
  animateCss: boolean;
  wowJs: boolean;
  sal: boolean;
  scrollReveal: boolean;
  splitting: boolean;
  lottie: boolean;
  dotlottie: boolean;
  typed: boolean;
  swiper: boolean;
  animeJs: boolean;
  motionOne: boolean;
  tsParticles: boolean;
  particlesJs: boolean;
  framerMotion: boolean;
  svelte: boolean;
  threejs: boolean;
}

/**
 * Detect which animation frameworks are used in the scraped HTML.
 * Uses DOM attribute inspection (cheerio) for reliable detection.
 */
export function detectFrameworksFromHtml(
  $: ReturnType<typeof cheerio.load>
): DetectedFrameworks {
  const html = $.html();

  return {
    aos:
      $("[data-aos]").length > 0 ||
      html.includes("aos.js") ||
      html.includes("aos.min") ||
      html.includes("data-aos"),

    gsap:
      html.includes("gsap") ||
      html.includes("TweenMax") ||
      html.includes("TweenLite") ||
      html.includes("GreenSock"),

    gsapScrollTrigger:
      html.includes("ScrollTrigger") ||
      html.includes("scrolltrigger"),

    animateCss:
      $('[class*="animate__"]').length > 0 ||
      html.includes("animate.css") ||
      html.includes("animate.min.css"),

    wowJs:
      $(".wow").length > 0 ||
      html.includes("wow.js") ||
      html.includes("wow.min"),

    sal:
      $("[data-sal]").length > 0 ||
      html.includes("sal.js") ||
      html.includes("sal.css"),

    scrollReveal:
      html.includes("ScrollReveal") ||
      html.includes("scrollreveal") ||
      $("[data-sr-id]").length > 0,

    splitting:
      $("[data-splitting]").length > 0 ||
      html.includes("splitting") ||
      $(".splitting").length > 0,

    lottie:
      $("lottie-player").length > 0 ||
      html.includes("lottie") ||
      html.includes("bodymovin"),

    dotlottie:
      $("dotlottie-player").length > 0 ||
      html.includes("dotlottie") ||
      html.includes("DotLottiePlayer") ||
      html.includes(".lottie"),

    typed:
      $(".typed-cursor").length > 0 ||
      $("[data-typed]").length > 0 ||
      html.includes("typed.js") ||
      html.includes("Typed("),

    swiper:
      $(".swiper").length > 0 ||
      $(".swiper-wrapper").length > 0 ||
      html.includes("swiper"),

    animeJs:
      html.includes("anime.js") ||
      html.includes("anime.min") ||
      html.includes("animejs"),

    motionOne:
      html.includes("@motionone") ||
      html.includes("motionOne") ||
      html.includes("motion.js"),

    tsParticles:
      html.includes("tsparticles") ||
      html.includes("tsParticles") ||
      $("[id*='tsparticles']").length > 0,

    particlesJs:
      html.includes("particles.js") ||
      html.includes("particlesJS") ||
      $("[id='particles-js']").length > 0,

    framerMotion:
      $("[data-framer-appear-id]").length > 0 ||
      $("[data-projection-id]").length > 0 ||
      $("[data-scraper-fm-type]").length > 0 ||
      html.includes("framer-motion") ||
      html.includes("__framer_metadata"),

    svelte:
      $('[class*="svelte-"]').length > 0 ||
      html.includes("__svelte") ||
      html.includes("sveltekit"),

    threejs:
      html.includes("three.js") ||
      html.includes("three.min") ||
      html.includes("THREE") ||
      $("canvas[data-scraper-preserve-canvas]").length > 0,
  };
}

// ── Collect all CDN download URLs ────────────────────────────────────────────

/**
 * Returns all CDN file URLs that need to be downloaded to ./assets/cdn/
 * for the detected frameworks.
 */
export function collectCdnDownloadUrls(
  frameworks: DetectedFrameworks
): Array<{ url: string; localName: string }> {
  const result: Array<{ url: string; localName: string }> = [];

  const toCheck: Array<[keyof DetectedFrameworks, string]> = [
    ["aos",               "aos"],
    ["gsap",              "gsap"],
    ["gsapScrollTrigger", "gsapScrollTrigger"],
    ["animateCss",        "animateCss"],
    ["wowJs",             "wowJs"],
    ["sal",               "sal"],
    ["scrollReveal",      "scrollReveal"],
    ["splitting",         "splitting"],
    ["lottie",            "lottie"],
    ["dotlottie",         "dotlottie"],
    ["typed",             "typed"],
    ["swiper",            "swiper"],
    ["animeJs",           "animeJs"],
    ["motionOne",         "motionOne"],
    ["tsParticles",       "tsParticles"],
    ["particlesJs",       "particlesJs"],
  ];

  for (const [fwKey, cdnKey] of toCheck) {
    if (!frameworks[fwKey]) continue;
    const entry = CDN_REGISTRY[cdnKey];
    if (!entry?.localCdn || !entry.downloadUrls) continue;

    for (const url of entry.downloadUrls) {
      const localName = url.split("/").pop()!.split("?")[0]!;
      result.push({ url, localName });
    }
  }

  return result;
}

// ── Main injection function ──────────────────────────────────────────────────

/**
 * Inject CDN scripts and stylesheets for all detected frameworks.
 * References LOCAL copies (./assets/cdn/) downloaded during scrape.
 */
export function injectCdnFrameworks(
  $: ReturnType<typeof cheerio.load>,
  frameworks: DetectedFrameworks
): void {
  const injected: string[] = [];
  const initScripts: string[] = [];

  const toInject: Array<[keyof DetectedFrameworks, string]> = [
    ["aos",               "aos"],
    ["gsap",              "gsap"],
    ["gsapScrollTrigger", "gsapScrollTrigger"],
    ["animateCss",        "animateCss"],
    ["wowJs",             "wowJs"],
    ["sal",               "sal"],
    ["scrollReveal",      "scrollReveal"],
    ["splitting",         "splitting"],
    ["lottie",            "lottie"],
    ["dotlottie",         "dotlottie"],
    ["typed",             "typed"],
    ["swiper",            "swiper"],
    ["animeJs",           "animeJs"],
    ["motionOne",         "motionOne"],
    ["tsParticles",       "tsParticles"],
    ["particlesJs",       "particlesJs"],
  ];

  for (const [fwKey, cdnKey] of toInject) {
    if (!frameworks[fwKey]) continue;

    const entry = CDN_REGISTRY[cdnKey];
    if (!entry) continue;

    // Inject CSS links into <head>
    if (entry.css) {
      for (const cssTag of entry.css) {
        const href = cssTag.match(/href="([^"]+)"/)?.[1] ?? "";
        if (href && $(`link[href="${href}"]`).length > 0) continue;
        $("head").append(`\n${cssTag}`);
      }
    }

    // Inject JS scripts before </body>
    if (entry.js) {
      for (const jsTag of entry.js) {
        const src = jsTag.match(/src="([^"]+)"/)?.[1] ?? "";
        if (src && $(`script[src="${src}"]`).length > 0) continue;
        $("body").append(`\n${jsTag}`);
      }
    }

    // Collect init scripts
    if (entry.initScript) {
      initScripts.push(entry.initScript.trim());
    }

    injected.push(entry.name);
  }

  // Inject combined init script (runs on window load)
  if (initScripts.length > 0) {
    const combinedInit = `<script data-scraper-cdn-init="true">
window.addEventListener('load', function() {
  // Re-initialize all detected animation frameworks
  ${initScripts.join("\n\n  ")}
});
</script>`;
    $("body").append(`\n${combinedInit}`);
  }

  if (injected.length > 0) {
    console.log(`📦 Injected CDN (local) for: ${injected.join(", ")}`);
  }
}

// ── Framer Motion per-element CSS fallback ───────────────────────────────────

/**
 * Full Framer Motion offline fallback.
 *
 * Instead of one generic animation, we:
 *  1. Read data-scraper-fm-type tags set during capture phase
 *  2. Assign each element the correct animation variant
 *  3. Use IntersectionObserver to play animations on scroll
 *
 * Variants: fade-up, fade-in, scale-in, slide-left, slide-right,
 *           blur-in, reveal (clip-path), rotate-x
 */
export function injectFramerMotionCssFallback(
  $: ReturnType<typeof cheerio.load>
): void {
  // ── CSS keyframe definitions ─────────────────────────────────────────────
  $("head").append(`<style data-scraper-framer-fallback="true">
/* ────────────────────────────────────────────────────────────────────────── */
/* Framer Motion offline fallback — per-element variant animations           */
/* ────────────────────────────────────────────────────────────────────────── */

/* All animations start hidden */
[data-scraper-fm-ready] {
  opacity: 0;
  will-change: opacity, transform, filter, clip-path;
}

/* ── Keyframe variants ─────────────────────────────────────────────────── */
@keyframes _fm-fade-up {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes _fm-fade-down {
  from { opacity: 0; transform: translateY(-24px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes _fm-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes _fm-scale-in {
  from { opacity: 0; transform: scale(0.85); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes _fm-scale-up {
  from { opacity: 0; transform: scale(0.6); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes _fm-slide-left {
  from { opacity: 0; transform: translateX(-40px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes _fm-slide-right {
  from { opacity: 0; transform: translateX(40px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes _fm-blur-in {
  from { opacity: 0; filter: blur(16px); }
  to   { opacity: 1; filter: blur(0); }
}
@keyframes _fm-reveal {
  from { opacity: 1; clip-path: inset(0 100% 0 0); }
  to   { opacity: 1; clip-path: inset(0 0% 0 0); }
}
@keyframes _fm-rotate-x {
  from { opacity: 0; transform: perspective(800px) rotateX(20deg); }
  to   { opacity: 1; transform: perspective(800px) rotateX(0deg); }
}
@keyframes _fm-rotate-y {
  from { opacity: 0; transform: perspective(800px) rotateY(20deg); }
  to   { opacity: 1; transform: perspective(800px) rotateY(0deg); }
}
</style>`);

  // ── JS: assign variant + IntersectionObserver ────────────────────────────
  $("body").append(`<script data-scraper-framer-io="true">
(function() {
  'use strict';

  var EASING = 'cubic-bezier(0.33, 1, 0.68, 1)';

  var framerEls = document.querySelectorAll(
    '[data-framer-appear-id], [data-projection-id], [data-motion-id]'
  );

  if (!framerEls.length) return;

  // Assign animation variant based on captured type data
  framerEls.forEach(function(el) {
    var rawTag = el.getAttribute('data-scraper-fm-type');
    var tag = {};
    try { if (rawTag) tag = JSON.parse(rawTag); } catch(e) {}

    var animName = '_fm-fade-up'; // default

    if (tag.hasClipPath)        animName = '_fm-reveal';
    else if (tag.hasBlur)       animName = '_fm-blur-in';
    else if (tag.hasRotate)     animName = '_fm-rotate-x';
    else if (tag.hasScale)      animName = '_fm-scale-in';
    else if (tag.hasTranslateX) animName = tag.hasTranslateX > 0 ? '_fm-slide-right' : '_fm-slide-left';
    else if (!tag.hasTranslateY && tag.hasOpacity) animName = '_fm-fade-in';

    var delay    = Math.max(0, parseFloat(tag.delay    || '0') * 1000);
    var duration = Math.max(0.3, parseFloat(tag.duration || '0.5'));

    // Set initial hidden state + animation config (paused until IO fires)
    el.style.opacity        = '0';
    el.style.animationName  = animName;
    el.style.animationDuration          = duration + 's';
    el.style.animationTimingFunction    = EASING;
    el.style.animationFillMode          = 'both';
    el.style.animationPlayState         = 'paused';
    el.style.animationDelay             = delay + 'ms';

    el.setAttribute('data-scraper-fm-ready', '1');
  });

  // IntersectionObserver — fires each animation when scrolled into view
  if (typeof IntersectionObserver === 'undefined') {
    // Fallback: show all immediately
    framerEls.forEach(function(el) {
      el.style.opacity = '1';
      el.style.animationPlayState = 'running';
    });
    return;
  }

  var io = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.style.animationPlayState = 'running';
      io.unobserve(entry.target);
    });
  }, { threshold: 0.06, rootMargin: '0px 0px -30px 0px' });

  document.querySelectorAll('[data-scraper-fm-ready]').forEach(function(el) {
    io.observe(el);
  });
})();
</script>`);
}

/**
 * Inject Svelte transition replay.
 * Svelte transition CSS is injected at runtime by the framework.
 * In offline mode we replay fade/slide transitions via IntersectionObserver.
 */
export function injectSvelteTransitionReplay(
  $: ReturnType<typeof cheerio.load>
): void {
  $("body").append(`<script data-scraper-svelte="true">
(function() {
  'use strict';
  if (typeof IntersectionObserver === 'undefined') return;

  // Find Svelte scoped elements that may have been hidden during transitions
  var svelteEls = document.querySelectorAll('[class*="svelte-"]');
  var toAnimate = [];

  svelteEls.forEach(function(el) {
    var cs = window.getComputedStyle(el);
    // Only target elements that appear hidden
    if (parseFloat(cs.opacity) < 0.5 || cs.visibility === 'hidden') {
      el.setAttribute('data-svelte-scraper', '1');
      toAnimate.push(el);
    }
  });

  if (!toAnimate.length) return;

  var io = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.style.opacity = '1';
      entry.target.style.visibility = 'visible';
      entry.target.style.transform = 'none';
      io.unobserve(entry.target);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });

  toAnimate.forEach(function(el) { io.observe(el); });
})();
</script>`);
}
