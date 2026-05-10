/**
 * Shared DOM processing utilities used by both static and dynamic scrapers.
 */

import * as cheerio from "cheerio";
import * as path from "path";
import { resolveUrl, computeRelativePath } from "./utils.js";

// ── Animation class stripping ────────────────────────────────────────────────

/**
 * Attributes that signal an element will be animated into view.
 * These are set by animation libraries on elements that start hidden.
 */
const ANIMATION_INTENT_ATTRS = [
  "data-aos",
  "data-framer-appear-id",
  "data-projection-id",
  "data-motion-id",
  "data-sal",
  "data-wow",
  "data-sr-id",
  "data-animate",
  "data-scroll",
  "data-splitting",
];

/** Check if element is a hover-only element (tooltip, menu, dropdown) */
function isHoverOnlyElement(el: any, $: ReturnType<typeof cheerio.load>): boolean {
  const cls = ($(el).attr("class") ?? "").toLowerCase();
  const role = $(el).attr("role") ?? "";
  return (
    cls.includes("tooltip") ||
    cls.includes("dropdown") ||
    cls.includes("popover") ||
    role === "tooltip" ||
    role === "menu" ||
    role === "listbox"
  );
}

function hasAnimationIntent(el: any, $: ReturnType<typeof cheerio.load>): boolean {
  if (isHoverOnlyElement(el, $)) return false;
  for (const attr of ANIMATION_INTENT_ATTRS) {
    if ($(el).attr(attr) !== undefined) return true;
  }
  const cls = $(el).attr("class") ?? "";
  return (
    cls.includes("animate__") ||
    cls.includes("aos-") ||
    /\bwow\b/.test(cls) ||
    cls.includes("sal-") ||
    cls.includes("sr-") ||
    cls.includes("reveal") ||
    cls.includes("scroll-animate") ||
    cls.includes("fade-in") ||
    cls.includes("slide-in") ||
    $(el).attr("data-framer-appear-id") !== undefined
  );
}

/**
 * Universal animation class stripping for static scraper.
 * Forces all animation-intent elements into their visible final state.
 */
export function stripAnimationClasses($: ReturnType<typeof cheerio.load>): void {
  // ── AOS ──────────────────────────────────────────────────────────────────
  $("[data-aos]").each((_, el) => {
    const cls = $(el).attr("class") ?? "";
    if (!cls.includes("aos-animate")) {
      $(el).attr("class", (cls + " aos-animate").trim());
    }
    $(el).removeAttr("data-aos");
    $(el).removeAttr("data-aos-delay");
    $(el).removeAttr("data-aos-duration");
    $(el).removeAttr("data-aos-offset");
  });

  // ── SAL (Scroll Animation Library) ───────────────────────────────────────
  $("[data-sal]").each((_, el) => {
    $(el).attr("data-sal-entered", "");
    const cls = $(el).attr("class") ?? "";
    if (!cls.includes("sal-animate")) {
      $(el).attr("class", (cls + " sal-animate").trim());
    }
  });

  // ── WOW.js ───────────────────────────────────────────────────────────────
  $(".wow").each((_, el) => {
    const cls = $(el).attr("class") ?? "";
    if (!cls.includes("animated")) {
      $(el).attr("class", (cls + " animated").trim());
    }
    const style = $(el).attr("style") ?? "";
    $(el).attr("style", style.replace(/visibility\s*:\s*hidden/gi, "visibility: visible"));
  });

  // ── Framer Motion ─────────────────────────────────────────────────────────
  $("[data-framer-appear-id]").each((_, el) => {
    $(el).removeAttr("data-framer-appear-id");
  });
  $("[data-projection-id]").each((_, el) => {
    $(el).removeAttr("data-projection-id");
  });

  // ── Animate.css ───────────────────────────────────────────────────────────
  $('[class*="animate__"]').each((_, el) => {
    const cls = $(el).attr("class") ?? "";
    if (!cls.includes("animate__animated")) {
      $(el).attr("class", ("animate__animated " + cls).trim());
    }
    // Remove long animation delays that would hide content in static view
    const style = $(el).attr("style") ?? "";
    if (/animation-delay/.test(style)) {
      $(el).attr("style", style.replace(/animation-delay\s*:[^;]+;?/g, ""));
    }
  });

  // ── Inline style cleanup: opacity:0 and translate transforms ─────────────
  // Applied universally when element has animation intent, OR when the
  // computed context clearly indicates a scroll-entry hidden state
  $("[style]").each((_, el) => {
    let style = $(el).attr("style") ?? "";
    let changed = false;

    const hasIntent = hasAnimationIntent(el, $);

    // Also catch elements with JUST opacity:0 and some transform — very common
    // pattern in Framer Motion, ScrollReveal, GSAP, etc.
    const hasOpacityZero = /opacity\s*:\s*0\b/.test(style);
    const hasTranslate = /(?:translate[XYZ3d]?|translateY|translateX)/.test(style);
    const hasScaleZero = /scale\s*\(\s*0/.test(style);
    const likelyEntryAnim = hasOpacityZero && (hasTranslate || hasScaleZero);

    if (hasIntent || likelyEntryAnim) {
      if (hasOpacityZero) {
        style = style.replace(/opacity\s*:\s*0[^;]*(;|$)/g, "opacity: 1;");
        changed = true;
      }
      if (/visibility\s*:\s*hidden/.test(style)) {
        style = style.replace(/visibility\s*:\s*hidden(;|$)/g, "visibility: visible;");
        changed = true;
      }
      if (hasTranslate || /clip-path\s*:\s*inset\s*\(\s*100/.test(style)) {
        style = style.replace(/transform\s*:[^;]*(;|$)/g, "");
        style = style.replace(/clip-path\s*:[^;]*(;|$)/g, "");
        changed = true;
      }
      if (hasScaleZero) {
        style = style.replace(/scale\s*\([^)]+\)/g, "scale(1)");
        changed = true;
      }
    }

    if (changed) {
      const cleaned = style.replace(/;\s*;/g, ";").replace(/^\s*;|;\s*$/g, "").trim();
      if (cleaned) $(el).attr("style", cleaned);
      else $(el).removeAttr("style");
    }
  });

  // ── Tailwind scroll-entry classes: force visible ──────────────────────────
  const tailwindEntryClasses = [
    "opacity-0", "invisible", "scale-0", "scale-90", "scale-x-0", "scale-y-0",
    "-translate-y-full", "translate-y-full", "-translate-x-full", "translate-x-full",
  ];
  tailwindEntryClasses.forEach((tailwindCls) => {
    $(`[class*="${tailwindCls}"]`).each((_, el) => {
      if (isHoverOnlyElement(el, $)) return;
      const cls = $(el).attr("class") ?? "";
      // Skip if this is a group-hover: (hover-only state)
      if (cls.includes("group-hover:") || cls.includes("peer-hover:") || cls.includes("hover:")) return;
      const style = $(el).attr("style") ?? "";
      // Only fix if there's also a transition defined (entry animation pattern)
      if (style.includes("transition") || cls.includes("transition") || cls.includes("duration-")) {
        const newStyle = style +
          "; opacity: 1 !important; visibility: visible !important; transform: none !important;";
        $(el).attr("style", newStyle.replace(/^;\s*/, ""));
      }
    });
  });
}

// ── HTML rewriting helpers ───────────────────────────────────────────────────

export function rewriteAttr(
  $: ReturnType<typeof cheerio.load>,
  el: any,
  attr: string,
  pageUrl: string,
  assetMap: Map<string, string>,
  htmlOutputLocalPath: string
): void {
  const val = $(el).attr(attr);
  if (!val) return;
  const resolvedFull = resolveUrl(pageUrl, val);
  if (!resolvedFull) return;
  const localPath = assetMap.get(resolvedFull);
  if (localPath) {
    const rel = computeRelativePath(htmlOutputLocalPath, localPath);
    $(el).attr(attr, rel);
  }
}

export function rewriteSrcset(
  $: ReturnType<typeof cheerio.load>,
  el: any,
  pageUrl: string,
  assetMap: Map<string, string>,
  htmlOutputLocalPath: string
): void {
  const srcset = $(el).attr("srcset") ?? "";
  const rewritten = srcset
    .split(",")
    .map((part: string) => {
      const [u, ...desc] = part.trim().split(/\s+/);
      if (!u) return part;
      const resolved = resolveUrl(pageUrl, u);
      if (!resolved) return part;
      const localPath = assetMap.get(resolved);
      if (!localPath) return part;
      const rel = computeRelativePath(htmlOutputLocalPath, localPath);
      return [rel, ...desc].join(" ");
    })
    .join(", ");
  $(el).attr("srcset", rewritten);
}

export function rewriteInlineStyles(
  $: ReturnType<typeof cheerio.load>,
  el: any,
  assetMap: Map<string, string>,
  htmlOutputLocalPath: string
): void {
  let style = $(el).attr("style") ?? "";
  for (const [originalUrl, localPath] of assetMap.entries()) {
    const rel = computeRelativePath(htmlOutputLocalPath, localPath);
    style = style.split(originalUrl).join(rel);
  }
  $(el).attr("style", style);
}

/**
 * Full HTML post-processing pipeline: rewrite all URLs.
 * NOTE: Does NOT strip animation classes — the dynamic scraper captures the
 * fully-animated DOM state directly from the browser, so stripping would undo it.
 * The static scraper calls stripAnimationClasses separately before this.
 */
export function postProcessHtml(
  $: ReturnType<typeof cheerio.load>,
  pageUrl: string,
  assetMap: Map<string, string>,
  htmlOutputLocalPath: string = "index.html",
  cssTexts: string[] = [],
  stripAnimations: boolean = false
): void {
  if (stripAnimations) {
    console.log(`\n🎨 Stripping animation classes (making all sections visible)...`);
    stripAnimationClasses($);
  }

  // Rewrite asset references to local paths
  $("link[href]").each((_, el) => rewriteAttr($, el, "href", pageUrl, assetMap, htmlOutputLocalPath));
  $("script[src]").each((_, el) => rewriteAttr($, el, "src", pageUrl, assetMap, htmlOutputLocalPath));
  $("img[src]").each((_, el) => rewriteAttr($, el, "src", pageUrl, assetMap, htmlOutputLocalPath));
  $("source[src]").each((_, el) => rewriteAttr($, el, "src", pageUrl, assetMap, htmlOutputLocalPath));
  $("video[poster]").each((_, el) => rewriteAttr($, el, "poster", pageUrl, assetMap, htmlOutputLocalPath));
  $("object[data]").each((_, el) => rewriteAttr($, el, "data", pageUrl, assetMap, htmlOutputLocalPath));
  $("embed[src]").each((_, el) => rewriteAttr($, el, "src", pageUrl, assetMap, htmlOutputLocalPath));
  $("[srcset]").each((_, el) => rewriteSrcset($, el, pageUrl, assetMap, htmlOutputLocalPath));
  $("[style]").each((_, el) => rewriteInlineStyles($, el, assetMap, htmlOutputLocalPath));

  // Remove canonical link (would point back to the live site)
  $('link[rel="canonical"]').remove();

  // Auto-detect and apply dark theme only when CSS explicitly requires it
  applyDarkThemeIfNeeded($, cssTexts);
}

/**
 * Only apply dark theme if CSS has .dark{} rules AND the site is clearly dark-first.
 * Does NOT blindly apply to all Next.js sites.
 */
function applyDarkThemeIfNeeded(
  $: ReturnType<typeof cheerio.load>,
  cssTexts: string[] = []
): void {
  const htmlClass = $("html").attr("class") ?? "";
  if (htmlClass.includes("dark")) return;

  // Check explicit color-scheme meta
  const colorScheme = $('meta[name="color-scheme"]').attr("content") ?? "";
  if (colorScheme === "dark") {
    $("html").attr("class", `${htmlClass} dark`.trim());
    console.log(`🌙 Applied dark theme (color-scheme meta)`);
    return;
  }

  // Check data-theme attribute
  const dataTheme = $("html").attr("data-theme") ?? $("body").attr("data-theme") ?? "";
  if (dataTheme === "dark") {
    $("html").attr("class", `${htmlClass} dark`.trim());
    console.log(`🌙 Applied dark theme (data-theme attribute)`);
    return;
  }

  // Only apply dark class if CSS has .dark{--background: rules (dark-first design)
  // AND the page has no explicit light theme indicators
  const bodyClass = $("body").attr("class") ?? "";
  const hasLightIndicator =
    htmlClass.includes("light") ||
    bodyClass.includes("light") ||
    dataTheme === "light";

  if (hasLightIndicator) return;

  // Check CSS for dark-first design: .dark{ with background variable
  let hasDarkFirstCSS = false;
  for (const css of cssTexts) {
    if (
      (css.includes(".dark{--background") || css.includes(".dark { --background")) &&
      !css.includes(":root{--background") && !css.includes(":root { --background")
    ) {
      hasDarkFirstCSS = true;
      break;
    }
  }

  // Also check inline <style> tags
  if (!hasDarkFirstCSS) {
    $("style").each((_, el) => {
      const text = $(el).html() ?? "";
      if (
        (text.includes(".dark{--background") || text.includes(".dark { --background")) &&
        !text.includes(":root{--background") && !text.includes(":root { --background")
      ) {
        hasDarkFirstCSS = true;
      }
    });
  }

  if (hasDarkFirstCSS) {
    $("html").attr("class", `${htmlClass} dark`.trim());
    const existingStyle = $("html").attr("style") ?? "";
    if (!existingStyle.includes("color-scheme")) {
      $("html").attr("style", `${existingStyle}; color-scheme: dark;`.replace(/^;\s*/, ""));
    }
    console.log(`🌙 Applied dark theme (dark-first CSS detected)`);
  }
}
