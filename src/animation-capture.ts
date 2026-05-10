/**
 * Animation capture and preservation utilities.
 *
 * Extracts ALL CSS animation-related rules from stylesheets:
 *   • @keyframes (including cross-origin via fetch fallback)
 *   • @property (CSS Houdini registered properties)
 *   • @layer blocks containing animations
 *   • CSS custom properties (--vars) used by animations
 *   • Computed animation names for dynamically-created keyframes
 */

import * as cheerio from "cheerio";

/**
 * Extract @keyframes blocks from CSS text using a brace-balanced parser.
 * Also extracts @property and animation-related @layer blocks.
 */
export function extractKeyframesFromCSS(cssTexts: string[]): string {
  const collected = new Set<string>();

  for (const css of cssTexts) {
    extractAtRuleBlocks(css, "@keyframes", collected);
    extractAtRuleBlocks(css, "@-webkit-keyframes", collected);
    extractAtRuleBlocks(css, "@property", collected);
    extractAnimationLayerBlocks(css, collected);
    extractCSSCustomProperties(css, collected);
  }

  return [...collected].join("\n");
}

/**
 * Extract all @<rule> blocks from CSS using brace-balanced parsing.
 */
function extractAtRuleBlocks(css: string, rule: string, out: Set<string>): void {
  let i = 0;
  while (i < css.length) {
    const idx = css.indexOf(rule, i);
    if (idx === -1) break;

    // Find the opening brace
    const openBrace = css.indexOf("{", idx);
    if (openBrace === -1) break;

    // Walk forward balancing braces
    let depth = 0;
    let end = openBrace;
    while (end < css.length) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") {
        depth--;
        if (depth === 0) { end++; break; }
      }
      end++;
    }

    out.add(css.slice(idx, end).trim());
    i = end;
  }
}

/**
 * Extract @layer blocks that contain keyframes or animation properties.
 */
function extractAnimationLayerBlocks(css: string, out: Set<string>): void {
  let i = 0;
  while (i < css.length) {
    const idx = css.indexOf("@layer", i);
    if (idx === -1) break;

    const openBrace = css.indexOf("{", idx);
    if (openBrace === -1) break;

    let depth = 0;
    let end = openBrace;
    while (end < css.length) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") {
        depth--;
        if (depth === 0) { end++; break; }
      }
      end++;
    }

    const block = css.slice(idx, end).trim();
    // Only include if it contains animation-related content
    if (
      block.includes("@keyframes") ||
      block.includes("animation") ||
      block.includes("transition") ||
      block.includes("transform")
    ) {
      out.add(block);
    }
    i = end;
  }
}

/**
 * Extract CSS custom properties (--var) that are animation-related from
 * :root, .dark, html, body selectors.
 */
function extractCSSCustomProperties(css: string, out: Set<string>): void {
  // Match :root { ... }, html { ... }, body { ... }, .dark { ... }
  const selectorPattern = /(:root|html|body|\.dark|\.light)\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = selectorPattern.exec(css)) !== null) {
    const block = match[2] ?? "";
    // Check if it has animation-related custom properties
    if (
      /--\w*(animation|transition|duration|delay|easing|timing|motion|ease|spring|bounce|keyframe)/i.test(block)
    ) {
      out.add(`${match[1]} {\n${block}\n}`);
    }
  }
}

/**
 * Inject preserved CSS animations + custom properties into document <head>.
 */
export function injectPreservedAnimations(
  $: ReturnType<typeof cheerio.load>,
  cssContent: string
): void {
  if (!cssContent.trim()) return;
  $("head").append(`<style data-scraper-animations="true">\n${cssContent}\n</style>`);
}

/**
 * Add a <style> block with a blink-cursor keyframe for typing cursors
 * (works even if the JS-based typer is not running).
 */
export function injectCursorKeyframe(
  $: ReturnType<typeof cheerio.load>
): void {
  const hasCursor =
    $(".typed-cursor").length > 0 ||
    $('[class*="cursor"]').length > 0 ||
    $("[class*='blink']").length > 0;

  if (!hasCursor) return;

  $("head").append(`<style data-scraper-cursor="true">
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.typed-cursor,
[class*="cursor-blink"],
[class*="typing-cursor"] {
  animation: blink-cursor 1s step-end infinite !important;
  opacity: 1 !important;
}
</style>`);
}

/**
 * Extract all animation CSS from stylesheets accessible in the browser.
 *
 * KEY IMPROVEMENTS over previous version:
 *  1. Cross-origin stylesheet fetch fallback (CDN sheets via CORS)
 *  2. Computed animation name API (window.getComputedStyle + el.getAnimations())
 *  3. @layer recursion (CSSLayerBlockRule.cssRules)
 *  4. @property via CSS.PropertyDescriptors (Houdini)
 *
 * This runs inside the browser via page.evaluate() and returns a CSS string.
 */
export const EXTRACT_CSS_SCRIPT = `(function() {
  var collected = new Set();
  var fetchPromises = [];

  function extractBraceBalanced(css, rule) {
    var i = 0;
    while (i < css.length) {
      var idx = css.indexOf(rule, i);
      if (idx === -1) break;
      var openBrace = css.indexOf('{', idx);
      if (openBrace === -1) break;
      var depth = 0, end = openBrace;
      while (end < css.length) {
        if (css[end] === '{') depth++;
        else if (css[end] === '}') { depth--; if (depth === 0) { end++; break; } }
        end++;
      }
      collected.add(css.slice(idx, end).trim());
      i = end;
    }
  }

  // ── Recurse into a CSSRuleList ─────────────────────────────────────────
  function processRules(rules) {
    if (!rules) return;
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      try {
        // @keyframes
        if (rule instanceof CSSKeyframesRule || rule.type === 7) {
          collected.add(rule.cssText);
          continue;
        }
        // @property (Houdini)
        if (rule.type === 6 || (rule.constructor && rule.constructor.name === 'CSSPropertyRule')) {
          collected.add(rule.cssText);
          continue;
        }
        // @media — recurse
        if (rule instanceof CSSMediaRule || rule.type === 4) {
          processRules(rule.cssRules);
          continue;
        }
        // @supports — recurse
        if (rule instanceof CSSSupportsRule || rule.type === 12) {
          processRules(rule.cssRules);
          continue;
        }
        // @layer — recurse
        if (rule.type === 1 && rule.cssText && rule.cssText.startsWith('@layer')) {
          if (rule.cssRules) processRules(rule.cssRules);
          // Also capture the raw text if it has keyframes
          if (rule.cssText.includes('@keyframes') || rule.cssText.includes('animation')) {
            collected.add(rule.cssText);
          }
          continue;
        }
        // CSSLayerBlockRule (newer browsers)
        if (rule.constructor && rule.constructor.name === 'CSSLayerBlockRule') {
          if (rule.cssRules) processRules(rule.cssRules);
          continue;
        }
      } catch(e) {}
    }
  }

  // ── Process all accessible stylesheets ────────────────────────────────
  try {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      try {
        var rules = sheet.cssRules || [];
        processRules(rules);
      } catch(e) {
        // Cross-origin sheet — try to fetch it
        if (sheet.href) {
          (function(href) {
            fetchPromises.push(
              fetch(href, { mode: 'cors', cache: 'force-cache' })
                .then(function(r) { return r.ok ? r.text() : ''; })
                .then(function(text) {
                  if (!text) return;
                  extractBraceBalanced(text, '@keyframes');
                  extractBraceBalanced(text, '@-webkit-keyframes');
                  extractBraceBalanced(text, '@property');
                })
                .catch(function() {})
            );
          })(sheet.href);
        }
      }

      // Inline style tags — extract verbatim for accuracy
      try {
        if (!sheet.href) {
          var owner = sheet.ownerNode;
          if (owner && owner.tagName === 'STYLE') {
            var text = owner.textContent || '';
            extractBraceBalanced(text, '@keyframes');
            extractBraceBalanced(text, '@-webkit-keyframes');
            extractBraceBalanced(text, '@property');
          }
        }
      } catch(e) {}
    }
  } catch(e) {}

  // ── Computed animation names from live elements ────────────────────────
  // For dynamically injected keyframes (e.g. Framer Motion, GSAP CustomEase)
  try {
    var animatedEls = document.querySelectorAll('[style*="animation"], [class*="animate"], [class*="motion"]');
    animatedEls.forEach(function(el) {
      try {
        var anims = el.getAnimations ? el.getAnimations() : [];
        anims.forEach(function(anim) {
          if (anim.effect && anim.effect.getKeyframes) {
            var kfs = anim.effect.getKeyframes();
            var name = (anim.animationName || '').trim();
            if (name && name !== 'none' && kfs.length > 0) {
              // Reconstruct a basic @keyframes block from computed keyframes
              var steps = kfs.map(function(kf) {
                var offset = kf.computedOffset !== undefined ? kf.computedOffset : '';
                var props = Object.keys(kf)
                  .filter(function(k) { return k !== 'computedOffset' && k !== 'offset' && k !== 'easing' && k !== 'composite'; })
                  .map(function(k) { return k.replace(/([A-Z])/g, '-$1').toLowerCase() + ': ' + kf[k] + ';'; })
                  .join(' ');
                return (offset * 100) + '% { ' + props + ' }';
              }).join(' ');
              collected.add('@keyframes ' + name + ' { ' + steps + ' }');
            }
          }
        });
      } catch(e) {}
    });
  } catch(e) {}

  // ── Houdini registered properties ────────────────────────────────────
  try {
    if (CSS && CSS.paintWorklet && window.__registeredProperties) {
      window.__registeredProperties.forEach(function(p) {
        collected.add('@property ' + p.name + ' { syntax: "' + p.syntax + '"; inherits: ' + p.inherits + '; initial-value: ' + p.initialValue + '; }');
      });
    }
  } catch(e) {}

  // Wait for cross-origin fetches then return
  return Promise.all(fetchPromises).then(function() {
    return Array.from(collected).join('\\n');
  }).catch(function() {
    return Array.from(collected).join('\\n');
  });
})();`;
