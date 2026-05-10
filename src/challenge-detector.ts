/**
 * Bot challenge detection from HTML content.
 *
 * Detects Cloudflare, DataDome, Akamai, PerimeterX challenge pages.
 */

/**
 * Detect bot protection from a static HTTP response.
 * Used during auto-detection phase before launching a browser.
 */
export function detectBotProtectionFromHtml(
  html: string,
  statusCode: number
): string | null {
  // Cloudflare
  if (
    html.includes("cf-browser-verification") ||
    html.includes("challenge-platform") ||
    html.includes("Just a moment...")
  ) {
    return "cloudflare";
  }

  // Cloudflare Turnstile
  if (html.includes("cf-turnstile") || html.includes("challenges.cloudflare.com")) {
    return "cloudflare-turnstile";
  }

  // DataDome
  if (html.includes("datadome") || html.includes("geo.captcha-delivery.com")) {
    return "datadome";
  }

  // Akamai
  if (html.includes("_abck") || html.includes("ak_bmsc")) {
    return "akamai";
  }

  // PerimeterX
  if (html.includes("_pxhd") || html.includes("px-captcha")) {
    return "perimeterx";
  }

  // Generic block responses
  if (statusCode === 403 || statusCode === 503) {
    if (html.includes("blocked") || html.includes("access denied") || html.length < 1000) {
      return "unknown";
    }
  }

  return null;
}
