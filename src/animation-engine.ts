/**
 * Universal Animation Engine — runs INSIDE the browser via page.evaluate().
 *
 * KEY DESIGN PRINCIPLE:
 * - We REMOVE animation start-state inline styles (don't add !important overrides)
 * - This lets CSS transitions, :hover effects, and theme transitions all work normally
 * - We only set inline styles where the element has NO other way to be visible
 * - We TAG GSAP/Framer elements with data-scraper-* attributes for offline replay
 *
 * Framework support:
 *   Framer Motion, GSAP, AOS, SAL, WOW, Animate.css, Lottie,
 *   Motion One, Anime.js, Splitting.js, Typed.js, particles.js, tsParticles,
 *   Svelte, Astro View Transitions
 */

export const DETECT_AND_FREEZE_SCRIPT = `(function() {
  'use strict';

  // ── 1. Library Detection ─────────────────────────────────────────────────
  var libs = {
    framerMotion:   !!(window.__framer_metadata || window.FramerMotion ||
                       document.querySelector('[data-framer-appear-id]') ||
                       document.querySelector('[data-motion-id]') ||
                       document.querySelector('[data-projection-id]')),
    gsap:           !!(window.gsap || window.GreenSockGlobals || window.TweenMax || window.TweenLite),
    scrollTrigger:  !!(window.ScrollTrigger),
    aos:            !!(window.AOS || document.querySelector('[data-aos]')),
    scrollReveal:   !!(window.ScrollReveal),
    sal:            !!(window.sal || document.querySelector('[data-sal]')),
    wow:            !!(window.WOW || document.querySelector('.wow')),
    animateCss:     !!document.querySelector('[class*="animate__"]'),
    lottie:         !!(window.lottie || window.bodymovin || document.querySelector('lottie-player')),
    dotlottie:      !!(window.DotLottiePlayer || document.querySelector('dotlottie-player') || document.querySelector('[src*=".lottie"]')),
    motionOne:      !!(window.Motion || window.motion),
    animeJs:        !!(window.anime),
    splitting:      !!(window.Splitting || document.querySelector('[data-splitting]')),
    swiper:         !!(window.Swiper || document.querySelector('.swiper')),
    typed:          !!(window.Typed || document.querySelector('.typed-cursor')),
    particles:      !!(window.particlesJS || window.tsParticles || document.querySelector('[id*="particles"]')),
    three:          !!(window.THREE),
    svelte:         !!document.querySelector('[class*="svelte-"]'),
    tailwindAnims:  !!(document.querySelector('[class*="opacity-0"]') || document.querySelector('[class*="translate-y-"]') || document.querySelector('.hero-reveal')),
  };

  // ── 2. GSAP: Fast-forward all timelines + tag animated elements ──────────
  if (libs.gsap && window.gsap) {
    try {
      // Fast-forward all timelines to end state
      window.gsap.globalTimeline.progress(1, false);
    } catch(e) {}

    if (window.ScrollTrigger) {
      try {
        window.ScrollTrigger.getAll().forEach(function(t) {
          try { t.progress(1, false); } catch(e) {}
        });
      } catch(e) {}
    }

    // ── TAG GSAP animated elements for offline replay ────────────────────
    try {
      var gsapTargets = new Set();
      window.gsap.globalTimeline.getChildren(true, true, false).forEach(function(tween) {
        try {
          if (tween.targets && typeof tween.targets === 'function') {
            tween.targets().forEach(function(t) {
              if (t instanceof Element) gsapTargets.add(t);
            });
          }
        } catch(e) {}
      });

      gsapTargets.forEach(function(el) {
        try {
          var cs = getComputedStyle(el);
          // Store the final (current, post-fast-forward) state
          var finalState = {
            opacity: cs.opacity,
            transform: cs.transform !== 'none' ? cs.transform : '',
            filter: cs.filter !== 'none' ? cs.filter : '',
            clipPath: cs.clipPath !== 'none' ? cs.clipPath : '',
          };
          // Store a typical from-state (will be overridden by scroll replay)
          var fromState = { opacity: '0', y: 40 };
          el.setAttribute('data-gsap-to',   JSON.stringify(finalState));
          el.setAttribute('data-gsap-from', JSON.stringify(fromState));
        } catch(e) {}
      });
    } catch(e) {}

    // ── TAG GSAP pinned sections ─────────────────────────────────────────
    if (window.ScrollTrigger) {
      try {
        window.ScrollTrigger.getAll().forEach(function(st) {
          try {
            if (st.pin) {
              st.pin.setAttribute('data-gsap-pin', '1');
              var pinLen = (st.end || 0) - (st.start || 0);
              st.pin.setAttribute('data-gsap-pin-length', Math.max(pinLen, 200) + 'px');
            }
          } catch(e) {}
        });
      } catch(e) {}
    }
  }

  // ── 3. Framer Motion: tag elements with variant info ─────────────────────
  try {
    document.querySelectorAll('[data-framer-appear-id], [data-projection-id], [data-motion-id]').forEach(function(el) {
      try {
        var cs = getComputedStyle(el);
        var tag = {
          // Detect what kind of animation this element uses
          hasOpacity:    parseFloat(cs.opacity) < 0.5,
          hasTranslateY: /translateY\((?!0)/.test(cs.transform),
          hasTranslateX: /translateX\((?!0)/.test(cs.transform),
          hasScale:      /scale\((?!1)/.test(cs.transform) || /scaleY|scaleX/.test(cs.transform),
          hasRotate:     /rotate\((?!0)/.test(cs.transform) || /rotateX|rotateY/.test(cs.transform),
          hasBlur:       /blur\([1-9]/.test(cs.filter),
          hasClipPath:   cs.clipPath !== 'none' && cs.clipPath !== '',
          delay:   el.getAttribute('data-framer-delay') || el.getAttribute('data-delay') || '0',
          duration: el.getAttribute('data-framer-duration') || '0.5',
          // Capture the appear-id for stagger calculation
          appearId: el.getAttribute('data-framer-appear-id') || '',
        };
        el.setAttribute('data-scraper-fm-type', JSON.stringify(tag));
      } catch(e) {}
    });
  } catch(e) {}

  // ── 4. Anime.js ──────────────────────────────────────────────────────────
  if (window.anime && window.anime.running) {
    try {
      window.anime.running.forEach(function(anim) {
        try { anim.seek(anim.duration); } catch(e) {}
      });
    } catch(e) {}
  }

  // ── 5. Universal fix: remove animation start-state styles ────────────────
  // CRITICAL: We REMOVE opacity:0 and transforms from inline styles
  // rather than setting opacity:1 !important — this preserves hover/transition CSS
  // ── Detect hover-ONLY elements that must keep their resting state ──────────
  // These are NOT entry animations — they are hover reveal overlays that live
  // at translateY(100%) / opacity:0 normally and transition on :hover.
  // If we strip them the button hover effect is permanently broken.
  function isHoverOnlyEl(el) {
    try {
      // Radix / headless UI overlays
      if (el.closest('[data-radix-popper-content-wrapper]')) return true;
      if (el.closest('[role="tooltip"]')) return true;
      if (el.closest('[role="menu"]')) return true;
      var cls = (typeof el.className === 'string' ? el.className : '') || '';
      if (/tooltip|dropdown|popover|menu-panel/i.test(cls)) return true;

      // ── Hover overlay detection ────────────────────────────────────────
      // Pattern: absolute-positioned element inside an overflow:hidden parent
      // These elements sit at translateY(100%) and slide in on hover.
      var cs = getComputedStyle(el);
      if (cs.position === 'absolute' || cs.position === 'fixed') {
        var parent = el.parentElement;
        if (parent) {
          var pcs = getComputedStyle(parent);
          if (pcs.overflow === 'hidden' || pcs.overflowY === 'hidden') {
            // Has a transition (hover-driven) but no animation (not entry-driven)
            if (cs.transition && cs.transition !== 'all 0s ease 0s' && !cs.animationName) {
              return true;
            }
          }
        }
      }

      // Detect clip-path: inset(100% 0 0 0) — this is the Framer Motion
      // clip-path hover reveal pattern, must NOT be stripped
      var style = el.getAttribute('style') || '';
      if (/clip-path\s*:\s*inset\(100%\s+0\s+0\s+0\)/.test(style)) return true;

      // Detect z-15 / z-10 overlay elements inside relative overflow-hidden buttons
      if (/\bz-(?:10|15|20)\b/.test(cls)) {
        var ancestor = el.closest('a, button, [role="button"]');
        if (ancestor) {
          var acs = getComputedStyle(ancestor);
          if (acs.overflow === 'hidden') return true;
        }
      }
    } catch(e) {}
    return false;
  }

  function removeStartStateStyle(el) {
    if (isHoverOnlyEl(el)) return;
    var style = el.getAttribute('style');
    if (!style) return;

    var original = style;

    // Strip opacity: 0 (or very low) — entry animation start state
    style = style.replace(/\bopacity\s*:\s*0(?:\.\d+)?\s*;?/gi, '');

    // Strip entry-animation translateY/X (but NOT translateY(100%) which is hover overlay)
    // Only strip values that are clearly animation enter states (small px or % < 100%)
    style = style.replace(/\btransform\s*:\s*translateY\(\s*(?:-?\d{1,2}(?:\.\d+)?(?:px|rem|em|vh)?|[1-9]\d?%)\s*\)\s*;?/gi, '');
    style = style.replace(/\btransform\s*:\s*translateX\(\s*(?:-?\d{1,2}(?:\.\d+)?(?:px|rem|em|vh)?|[1-9]\d?%)\s*\)\s*;?/gi, '');
    style = style.replace(/\btransform\s*:\s*translate\(\s*-?\d[^)]{0,40}\)\s*;?/gi, '');
    style = style.replace(/\btransform\s*:\s*translate3d\([^)]{0,80}\)\s*;?/gi, '');

    // Strip scale(0) / scale(0.xx) entry animations
    style = style.replace(/\btransform\s*:\s*scale\s*\(\s*0(?:\.\d+)?\s*\)\s*;?/gi, '');

    // Strip matrix() transforms (entry animation patterns — large tx/ty offsets)
    if (style.indexOf('matrix') !== -1) {
      var matStart = style.indexOf('matrix');
      var pOpen = style.indexOf('(', matStart);
      var pClose = style.indexOf(')', pOpen);
      if (pOpen > 0 && pClose > pOpen) {
        var isM3d = style.slice(matStart, matStart + 8) === 'matrix3d';
        var nums = style.slice(pOpen + 1, pClose).split(',').map(parseFloat);
        var strip = false;
        if (!isM3d && nums.length === 6) strip = Math.abs(nums[4] || 0) > 5 || Math.abs(nums[5] || 0) > 5;
        if (isM3d && nums.length === 16) strip = Math.abs(nums[12] || 0) > 5 || Math.abs(nums[13] || 0) > 5;
        if (strip) {
          var propStart = style.lastIndexOf('transform', pOpen);
          var semiEnd = style.indexOf(';', pClose);
          if (propStart >= 0) {
            style = style.slice(0, propStart).trimEnd() + (semiEnd >= 0 ? style.slice(semiEnd + 1) : '');
          }
        }
      }
    }

    // Strip blur-in animation entry state (not drop-shadow)
    var filterMatch = style.match(/\bfilter\s*:\s*([^;]+)/i);
    if (filterMatch) {
      var filterVal = filterMatch[1];
      if (/blur\s*\(\s*(?:[1-9]|\d{2})/.test(filterVal) && !filterVal.includes('drop-shadow')) {
        style = style.replace(/\bfilter\s*:[^;]+;?/gi, '');
      }
    }

    // Strip clip-path: inset(100%) ONLY when it's inset(100%) with NO sides (fully hidden)
    // NOT: inset(100% 0 0 0) which is the hover reveal clip pattern
    if (/clip-path\s*:\s*inset\(100%\s*\)/.test(style)) {
      style = style.replace(/\bclip-path\s*:\s*inset\(100%\s*\)\s*;?/gi, '');
    }

    // Strip visibility: hidden animation start state
    style = style.replace(/\bvisibility\s*:\s*hidden\s*;?/gi, '');

    // Clean up
    style = style.replace(/;;+/g, ';').replace(/^\s*;|;\s*$/g, '').trim();

    if (style !== original) {
      if (style) {
        el.setAttribute('style', style);
      } else {
        el.removeAttribute('style');
      }
    }
  }

  // Apply to ALL elements (except canvas — never touch canvas)
  var allEls = document.querySelectorAll('[style]:not(canvas)');
  for (var i = 0; i < allEls.length; i++) {
    removeStartStateStyle(allEls[i]);
  }

  // ── 6. AOS: ensure animate class is set ──────────────────────────────────
  document.querySelectorAll('[data-aos]').forEach(function(el) {
    el.classList.add('aos-animate');
  });
  if (window.AOS) {
    try { window.AOS.refreshHard(); } catch(e) {}
  }

  // ── 7. SAL ───────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-sal]').forEach(function(el) {
    el.setAttribute('data-sal-entered', '');
    el.classList.add('sal-animate');
  });

  // ── 8. WOW ───────────────────────────────────────────────────────────────
  document.querySelectorAll('.wow').forEach(function(el) {
    el.classList.add('animated');
    el.style.visibility = 'visible';
  });

  // ── 9. Animate.css ───────────────────────────────────────────────────────
  document.querySelectorAll('[class*="animate__"]').forEach(function(el) {
    if (!el.classList.contains('animate__animated')) {
      el.classList.add('animate__animated');
    }
  });

  // ── 10. Lottie ────────────────────────────────────────────────────────────
  try {
    var lottieLib = window.lottie || window.bodymovin;
    if (lottieLib && lottieLib.getRegisteredAnimations) {
      lottieLib.getRegisteredAnimations().forEach(function(anim) {
        try { anim.goToAndStop(1, true); } catch(e) {}
      });
    }
  } catch(e) {}

  // ── 11. Splitting.js ─────────────────────────────────────────────────────
  document.querySelectorAll('[data-splitting], .splitting').forEach(function(el) {
    el.querySelectorAll('.char, .word, .line').forEach(function(span) {
      removeStartStateStyle(span);
    });
  });

  // ── 12. Video: ensure muted autoplay ─────────────────────────────────────
  document.querySelectorAll('video').forEach(function(v) {
    v.muted = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
  });

  // ── 13. Svelte: ensure transitioned-in elements are visible ──────────────
  // Svelte adds visibility:hidden during transitions — remove it
  document.querySelectorAll('[class*="svelte-"][style*="visibility"]').forEach(function(el) {
    var style = el.getAttribute('style') || '';
    el.setAttribute('style', style.replace(/visibility\s*:\s*hidden\s*;?/gi, ''));
  });

  // ── 14. Tailwind animation entry-state class stripping ───────────────────
  // Removes class-based entry states (opacity-0, translate-y-12, blur-[4px],
  // scale-x-0, scale-y-0) from elements that have CSS transitions.
  // These are used by antimetal.com and Tailwind-based sites where JS removes
  // the classes on scroll-in. The scraper captures before JS fires.
  (function() {
    var STRIP_CLASSES = ['opacity-0', 'invisible', 'scale-x-0', 'scale-y-0', 'scale-0',
                         'scale-50', 'scale-75', 'scale-95'];
    var STRIP_PATTERNS = [
      /\btranslate-y-\d+\b/g,
      /\b-translate-y-\d+\b/g,
      /\btranslate-x-\d+\b/g,
      /\b-translate-x-\d+\b/g,
      /\bblur-\[[\d.]+(?:px|rem)\]\b/g,
      /\bblur-(?:sm|md|lg|xl|2xl|3xl)\b/g,
      /\bscale-\[[\d.]+\]\b/g,
    ];

    // Query elements that have Tailwind animation-entry classes
    var candidates;
    try {
      candidates = document.querySelectorAll(
        '[class*="opacity-0"],[class*="scale-x-0"],[class*="scale-y-0"],' +
        '[class*="translate-y-"],[class*="translate-x-"],[class*="blur-["],' +
        '.hero-reveal,.invisible'
      );
    } catch(e) { return; }

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (isHoverOnlyEl(el)) continue;

      var cls = (typeof el.className === 'string') ? el.className : '';
      if (!cls) continue;

      // Skip hover/focus/group-only utilities
      if (/\b(?:group-hover|peer-hover|hover|focus|focus-within|focus-visible):/.test(cls)) continue;

      // Skip dropdown, menu, tooltip, dialog overlays
      try {
        if (el.closest('[role="dialog"],[role="menu"],[role="tooltip"],[role="listbox"]')) continue;
        if (el.closest('[data-radix-popper-content-wrapper],[data-headlessui-state]')) continue;
        if (el.closest('[data-state="closed"]')) continue;
      } catch(e) {}

      var cs = window.getComputedStyle(el);
      if (cs.display === 'none') continue;

      // Only strip from elements with a CSS transition (animated elements)
      // OR from hero-reveal / delay-* elements (explicit animation markers)
      var hasTrans = cs.transitionDuration && cs.transitionDuration !== '0s';
      var isMarked = /\bhero-reveal\b/.test(cls) || /\bdelay-\d+\b/.test(cls) || /\banimate-in\b/.test(cls);

      if (!hasTrans && !isMarked) continue;

      var changed = false;
      var newCls = cls;

      // Strip named classes
      for (var j = 0; j < STRIP_CLASSES.length; j++) {
        if (el.classList.contains(STRIP_CLASSES[j])) {
          el.classList.remove(STRIP_CLASSES[j]);
          changed = true;
        }
      }

      // Strip pattern-matched classes (translate-y-12, blur-[4px], etc.)
      for (var k = 0; k < STRIP_PATTERNS.length; k++) {
        var pat = STRIP_PATTERNS[k];
        if (pat.test(newCls)) {
          newCls = newCls.replace(pat, ' ');
          changed = true;
        }
        pat.lastIndex = 0;
      }

      if (changed) {
        el.className = newCls.replace(/\s+/g, ' ').trim();
      }
    }
  })();

  // ── 15. CSS Houdini @property stub (for browsers without it) ─────────────
  // Track any registered properties so animation-capture.ts can export them
  try {
    if (window.CSS && CSS.registerProperty) {
      window.__registeredProperties = window.__registeredProperties || [];
      var _origRegister = CSS.registerProperty.bind(CSS);
      CSS.registerProperty = function(opts) {
        window.__registeredProperties.push(opts);
        return _origRegister(opts);
      };
    }
  } catch(e) {}

  return JSON.stringify(libs);
})();`;

/**
 * Script injected into the OUTPUT HTML.
 * Provides offline animation replay, theme toggle, interactions.
 */
export const OFFLINE_REPLAY_SCRIPT = ``;  // Not used directly — static-enhance.ts builds the script

/**
 * Script injected BEFORE page navigation.
 */
export const PAGE_INIT_SCRIPT = `
// Suppress analytics errors and stub globals
try { console.error = function(){}; } catch(e) {}
window.ga     = window.ga     || function(){};
window.gtag   = window.gtag   || function(){};
window.fbq    = window.fbq    || function(){};
window._hsq   = window._hsq  || [];
window.dataLayer = window.dataLayer || [];
window.intercomSettings = window.intercomSettings || {};
// Prevent Webpack chunk loading errors from crashing page
window.webpackChunkName = window.webpackChunkName || {};
`;

/**
 * Script to harvest ALL CSS custom properties from live getComputedStyle.
 * Two-pass: light-mode vars captured first, then dark-mode vars.
 * Uses a void getComputedStyle().display flush to force the browser to
 * recalculate styles after class/attribute manipulation before reading vars.
 * Returns an object: { root: Record<string,string>, dark: Record<string,string> }
 */
export const HARVEST_CSS_VARS_SCRIPT = `(function() {
  var root = document.documentElement;
  var body = document.body || root;

  // Force a style re-calculation flush (prevents stale computed values)
  function flushStyles() {
    void root.offsetHeight;
    void getComputedStyle(root).display;
  }

  function extractVars(el) {
    var cs = getComputedStyle(el);
    var vars = {};
    for (var i = 0; i < cs.length; i++) {
      var name = cs[i];
      if (name && name.startsWith('--')) {
        var val = cs.getPropertyValue(name).trim();
        if (val) vars[name] = val;
      }
    }
    // Also grab from body (some themes set vars on body)
    var bcs = getComputedStyle(body);
    for (var j = 0; j < bcs.length; j++) {
      var bname = bcs[j];
      if (bname && bname.startsWith('--') && !vars[bname]) {
        var bval = bcs.getPropertyValue(bname).trim();
        if (bval) vars[bname] = bval;
      }
    }
    return vars;
  }

  // Remember original state
  var wasDark = root.classList.contains('dark') ||
                root.getAttribute('data-theme') === 'dark' ||
                root.getAttribute('data-color-mode') === 'dark';

  // ── Pass 1: Light/root vars ────────────────────────────────────────────
  root.classList.remove('dark');
  root.classList.add('light');
  root.setAttribute('data-theme', 'light');
  root.setAttribute('data-color-mode', 'light');
  root.setAttribute('data-mode', 'light');
  body.classList.remove('dark');
  body.classList.add('light');
  body.setAttribute('data-theme', 'light');
  body.setAttribute('data-bs-theme', 'light');
  flushStyles();
  var rootVars = extractVars(root);

  // ── Pass 2: Dark vars ──────────────────────────────────────────────────
  root.classList.remove('light');
  root.classList.add('dark');
  root.setAttribute('data-theme', 'dark');
  root.setAttribute('data-color-mode', 'dark');
  root.setAttribute('data-mode', 'dark');
  body.classList.remove('light');
  body.classList.add('dark');
  body.setAttribute('data-theme', 'dark');
  body.setAttribute('data-bs-theme', 'dark');
  flushStyles();
  var darkVars = extractVars(root);

  // ── Restore original state ─────────────────────────────────────────────
  if (wasDark) {
    root.classList.remove('light');
    root.classList.add('dark');
    root.setAttribute('data-theme', 'dark');
    root.setAttribute('data-color-mode', 'dark');
    root.setAttribute('data-mode', 'dark');
    body.classList.remove('light');
    body.classList.add('dark');
    body.setAttribute('data-theme', 'dark');
    body.setAttribute('data-bs-theme', 'dark');
  } else {
    root.classList.remove('dark');
    root.classList.add('light');
    root.setAttribute('data-theme', 'light');
    root.setAttribute('data-color-mode', 'light');
    root.setAttribute('data-mode', 'light');
    body.classList.remove('dark');
    body.classList.add('light');
    body.setAttribute('data-theme', 'light');
    body.setAttribute('data-bs-theme', 'light');
  }
  flushStyles();

  return JSON.stringify({ root: rootVars, dark: darkVars });
})();`;
