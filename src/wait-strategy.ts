/**
 * Smart page-load wait strategy.
 *
 * Provides utilities for waiting until a page and its animations are
 * fully settled before capturing the DOM state.
 */

import type { Page } from "puppeteer-core";

/**
 * Wait for Web Animations API to report no running animations.
 * Falls back to a timeout if getAnimations() is not supported.
 */
export async function waitForAnimationsComplete(
  page: Page,
  timeoutMs: number = 5000
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const hasRunning = await page.evaluate(() => {
      try {
        const anims = document.getAnimations();
        return anims.some((a) => a.playState === "running");
      } catch {
        return false;
      }
    });

    if (!hasRunning) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Wait for a selector to appear, with a timeout.
 * Returns true if found, false if timed out.
 */
export async function waitForSelectorSafe(
  page: Page,
  selector: string,
  timeoutMs: number = 5000
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for network to be idle (no more than maxInflight requests).
 */
export async function waitForNetworkIdle(
  page: Page,
  maxInflight: number = 0,
  idleTimeMs: number = 500,
  timeoutMs: number = 10000
): Promise<void> {
  const start = Date.now();
  let inflightCount = 0;
  let idleSince = Date.now();

  const onRequest = () => { inflightCount++; idleSince = Date.now(); };
  const onResponse = () => { inflightCount = Math.max(0, inflightCount - 1); };
  const onFail = () => { inflightCount = Math.max(0, inflightCount - 1); };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFail);

  try {
    while (Date.now() - start < timeoutMs) {
      if (inflightCount <= maxInflight && Date.now() - idleSince >= idleTimeMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onFail);
  }
}

/**
 * Wait for the page's JavaScript to settle by checking that
 * the DOM hasn't changed for a period of time.
 */
export async function waitForDomStable(
  page: Page,
  stableMs: number = 500,
  timeoutMs: number = 8000
): Promise<void> {
  const start = Date.now();

  let lastHtmlLength = 0;
  let stableSince = Date.now();

  while (Date.now() - start < timeoutMs) {
    const htmlLength = await page.evaluate(() => document.body?.innerHTML?.length ?? 0);

    if (htmlLength !== lastHtmlLength) {
      lastHtmlLength = htmlLength;
      stableSince = Date.now();
    }

    if (Date.now() - stableSince >= stableMs) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
