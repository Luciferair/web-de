/**
 * Human-like behavioral simulation for bot evasion and animation triggering.
 *
 * Simulates realistic user interactions:
 *   • Natural mouse movements across the viewport
 *   • Hover over elements to trigger :hover CSS states
 *   • Smooth scroll with variable speed
 *   • Realistic timing with random jitter
 */

import type { Page } from "puppeteer-core";

/**
 * Simulate realistic mouse movement across the page.
 * This triggers :hover CSS states and mouseenter/mousemove events
 * that some animations depend on.
 */
export async function simulateMouseMovement(page: Page): Promise<void> {
  try {
    const viewport = page.viewport();
    if (!viewport) return;

    const { width, height } = viewport;

    // Move mouse in a natural S-curve pattern across the page
    const points = [
      { x: width * 0.1, y: height * 0.2 },
      { x: width * 0.5, y: height * 0.1 },
      { x: width * 0.9, y: height * 0.3 },
      { x: width * 0.7, y: height * 0.5 },
      { x: width * 0.3, y: height * 0.7 },
      { x: width * 0.5, y: height * 0.5 },
    ];

    for (const point of points) {
      await page.mouse.move(point.x, point.y, { steps: 5 });
      await sleep(randomBetween(50, 150));
    }
  } catch { /* Mouse simulation is best-effort */ }
}

/**
 * Hover over visible interactive elements to trigger hover animations.
 * Works for: CSS :hover transitions, mouseenter event handlers,
 * navigation menus, card hover effects, etc.
 */
export async function hoverInteractiveElements(page: Page): Promise<void> {
  try {
    const elements = await page.evaluate(() => {
      const results: Array<{ x: number; y: number; tag: string }> = [];
      const selectors = [
        "nav a", "header a", "button:not([disabled])",
        "[class*='card']", "[class*='item']",
        "a[href]", "[class*='project']", "[class*='skill']",
        "[class*='tech']", "[class*='feature']",
      ];

      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight) {
              results.push({
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                tag: el.tagName.toLowerCase(),
              });
            }
          });
        } catch { /* */ }
        if (results.length >= 10) break; // Limit to avoid too many hovers
      }
      return results.slice(0, 10);
    });

    for (const { x, y } of elements) {
      await page.mouse.move(x, y, { steps: 3 });
      await sleep(randomBetween(100, 300));
    }
  } catch { /* Best-effort */ }
}

/**
 * Scroll with variable speed to mimic human behavior.
 * More realistic than instant scrollTo — triggers scroll-bound animations
 * that check scroll velocity.
 */
export async function humanScroll(
  page: Page,
  targetY: number,
  fromY: number = 0
): Promise<void> {
  const distance = targetY - fromY;
  const steps = Math.max(10, Math.abs(Math.round(distance / 100)));
  const stepSize = distance / steps;

  for (let i = 0; i <= steps; i++) {
    const y = fromY + stepSize * i + randomBetween(-5, 5);
    await page.evaluate((scrollY) => {
      window.scrollTo({ top: scrollY, behavior: "instant" });
      window.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, Math.round(Math.max(0, y)));

    // Variable timing: faster in middle, slower at start/end
    const progress = i / steps;
    const eased = Math.sin(progress * Math.PI);
    const delay = Math.round(20 + (1 - eased) * 60 + randomBetween(0, 30));
    await sleep(delay);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
