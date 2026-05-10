/**
 * Centralized configuration & types for the scraper.
 */

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export const DEFAULT_TIMEOUT = 30000;
export const ASSET_TIMEOUT = 20000;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_EXTRA_WAIT_MS = 2000;
export const DEFAULT_MAX_SCROLL_PASSES = 10;

export interface ScrapeOptions {
  url: string;
  outputDir: string;
  concurrency?: number;
  timeout?: number;
}

export interface LoginOptions {
  url: string;
  user: string;
  pass: string;
  userField: string;
  passField: string;
  submitBtn: string;
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface StealthConfig {
  enabled: boolean;
  proxy?: ProxyConfig;
}

export interface DynamicScrapeOptions extends ScrapeOptions {
  cookiesFile?: string;
  loginOptions?: LoginOptions;
  manualLogin?: boolean;
  extraWaitMs?: number;
  stealth?: StealthConfig;
  maxScrollPasses?: number;
  interact?: boolean;
  captureCanvas?: boolean;
}

export interface DetectionResult {
  mode: "static" | "dynamic";
  framework: string | null;
  botProtection: string | null;
  animationLibraries: string[];
  needsStealth: boolean;
}

/** Fetch with timeout using AbortController */
export async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeout: number = DEFAULT_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}
