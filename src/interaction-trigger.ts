/**
 * Interactive element triggering utilities.
 *
 * Provides browser-side scripts and Node-side helpers to trigger
 * interactive elements (tabs, accordions, drawers, carousels, etc.)
 * so their content is captured in the scraped output.
 */

import type { Page } from "puppeteer-core";

/**
 * Run inside the browser: discovers and triggers all interactive elements
 * that might reveal additional content (tabs, accordions, load-more, etc.).
 */
export const TRIGGER_INTERACTIONS_SCRIPT = `(function() {
  var triggered = 0;

  // Open all <details> elements
  document.querySelectorAll('details:not([open])').forEach(function(el) {
    el.open = true;
    triggered++;
  });

  // Click role="tab" elements (tab panels)
  // First click all tabs one by one to capture each panel's content
  var tabLists = document.querySelectorAll('[role="tablist"]');
  tabLists.forEach(function(tablist) {
    var tabs = tablist.querySelectorAll('[role="tab"]');
    tabs.forEach(function(tab) {
      try { tab.click(); } catch(e) {}
      triggered++;
    });
  });

  // Expand collapsed accordions  
  document.querySelectorAll(
    '[data-accordion-item], [class*="accordion-item"], [class*="collapse-item"]'
  ).forEach(function(el) {
    var btn = el.querySelector('button, [role="button"]');
    if (btn && btn.getAttribute('aria-expanded') === 'false') {
      try { btn.click(); } catch(e) {}
      triggered++;
    }
  });

  // Trigger "Show More" / "Load More" buttons
  document.querySelectorAll(
    'button, [role="button"]'
  ).forEach(function(btn) {
    var text = (btn.textContent || '').toLowerCase().trim();
    if (/^(show|load|see|view) (more|all|project|work)/.test(text)) {
      try { btn.click(); } catch(e) {}
      triggered++;
    }
  });

  // Expand all aria-expanded=false elements that aren't nav menus
  document.querySelectorAll('[aria-expanded="false"]').forEach(function(el) {
    var label = ((el.getAttribute('aria-label') || '') + (el.className || '')).toLowerCase();
    if (/menu|nav|hamburger|sidebar|drawer/.test(label)) return; // Skip nav
    try { el.click(); } catch(e) {}
    triggered++;
  });

  return triggered;
})();`;

/**
 * Node-side helper: run the interactions script on a page.
 */
export async function triggerAllInteractions(page: Page): Promise<number> {
  try {
    const count = await page.evaluate(TRIGGER_INTERACTIONS_SCRIPT) as number;
    return count;
  } catch {
    return 0;
  }
}

/**
 * Trigger carousel/slider navigation to capture all slides.
 * Returns number of slide states captured.
 */
export async function triggerCarouselSlides(page: Page): Promise<number> {
  return await page.evaluate(() => {
    let captured = 0;

    // Swiper
    const swiperContainers = document.querySelectorAll('.swiper');
    swiperContainers.forEach(function(container) {
      const swiper = (container as any).swiper;
      if (swiper) {
        const total = swiper.slides?.length ?? 0;
        for (let i = 0; i < total; i++) {
          try { swiper.slideTo(i, 0, false); } catch(e) {}
          captured++;
        }
        try { swiper.slideTo(0, 0, false); } catch(e) {}
      }
    });

    // Slick
    const slickSliders = document.querySelectorAll('.slick-slider');
    slickSliders.forEach(function(slider) {
      const $slider = (window as any).jQuery?.(slider);
      if ($slider && $slider.slick) {
        try {
          const count = $slider.slick('getSlick').slideCount;
          for (let i = 0; i < count; i++) {
            $slider.slick('slickGoTo', i);
            captured++;
          }
          $slider.slick('slickGoTo', 0);
        } catch(e) {}
      }
    });

    return captured;
  });
}
