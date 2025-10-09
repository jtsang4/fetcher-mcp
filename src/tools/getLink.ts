import { Browser, Page } from "playwright";
import { BrowserService } from "../services/browserService.js";
import { FetchOptions } from "../types/index.js";
import { logger } from "../utils/logger.js";

/**
 * Tool definition for get_link
 */
export const getLinkTool = {
  name: "get_link",
  description:
    "Extract clickable links (<a href=...>) from a specified web page, returning absolute URLs when possible along with their titles",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "URL to fetch. Make sure to include the schema (http:// or https:// if not defined, preferring https for most cases)",
      },
      timeout: {
        type: "number",
        description:
          "Page loading timeout in milliseconds, default is 30000 (30 seconds)",
      },
      waitUntil: {
        type: "string",
        description:
          "Specifies when navigation is considered complete, options: 'load', 'domcontentloaded', 'networkidle', 'commit', default is 'load'",
      },
    },
    required: ["url"],
  },
};

/**
 * Implementation of the get_link tool
 */
export async function getLink(args: any) {
  const rawUrl = String(args?.url || "").trim();
  if (!rawUrl) {
    logger.error(`[GetLink] URL parameter missing`);
    throw new Error("URL parameter is required");
  }

  // Ensure URL has a scheme; prefer https
  const normalizedUrl = /^(https?:)\/\//i.test(rawUrl)
    ? rawUrl
    : `https://${rawUrl}`;

  const options: FetchOptions = {
    timeout: Number(args?.timeout) || 30000,
    waitUntil: String(args?.waitUntil || "load") as
      | "load"
      | "domcontentloaded"
      | "networkidle"
      | "commit",
    // Unused in this tool but required by BrowserService options
    extractContent: false,
    maxLength: 0,
    returnHtml: false,
    waitForNavigation: false,
    navigationTimeout: 10000,
    disableMedia: true,
    debug: args?.debug,
  };

  const browserService = new BrowserService(options);
  let browser: Browser | null = null;
  let page: Page | null = null;

  if (browserService.isInDebugMode()) {
    logger.debug(`[GetLink] Debug mode enabled for URL: ${normalizedUrl}`);
  }

  try {
    browser = await browserService.createBrowser();
    const { context, viewport } = await browserService.createContext(browser);
    page = await browserService.createPage(context, viewport);

    // Navigate
    page.setDefaultTimeout(options.timeout);
    try {
      await page.goto(normalizedUrl, {
        timeout: options.timeout,
        waitUntil: options.waitUntil,
      });
    } catch (gotoError: any) {
      // If timeout occurs, attempt to proceed to extract whatever is available
      if (
        (gotoError?.message || "").toLowerCase().includes("timeout")
      ) {
        logger.warn(
          `[GetLink] Navigation timeout; attempting to extract links from current DOM...`
        );
      } else {
        throw gotoError;
      }
    }

    // Small delay to allow late DOM updates
    await page.waitForTimeout(300);

    // Extract clickable link targets and titles in the page context
    type RawLink = { href: string; title: string };
    const rawLinks: RawLink[] = await page.evaluate(() => {
      const cleanup = (s: string | null | undefined) =>
        (s || "").replace(/\s+/g, " ").trim();

      // Skip protocols that don't navigate to a web page
      const isSkippable = (href: string) => {
        const h = href.trim().toLowerCase();
        return (
          !h ||
          h === "#" ||
          h.startsWith("#") ||
          h.startsWith("javascript:") ||
          h.startsWith("mailto:") ||
          h.startsWith("tel:") ||
          h.startsWith("data:")
        );
      };

      const links: RawLink[] = [];
      const pushLink = (href: string | null | undefined, title: string | null | undefined) => {
        const h = cleanup(href);
        if (!h || isSkippable(h)) return;
        links.push({ href: h, title: cleanup(title) });
      };

      // 1) Standard anchors
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
      for (const a of anchors) {
        const text = cleanup(a.textContent) || cleanup(a.getAttribute('title')) || cleanup(a.getAttribute('aria-label'));
        pushLink(a.getAttribute('href'), text);
      }

      // 2) SVG anchors (xlink:href or href)
      const svgAnchors = Array.from(document.querySelectorAll<SVGAElement>('a[xlink\\:href], a[href]'));
      for (const a of svgAnchors) {
        const href = a.getAttribute('href') || a.getAttribute('xlink:href');
        if (!href) continue;
        const text = cleanup((a as any).textContent) || cleanup(a.getAttribute('title')) || cleanup(a.getAttribute('aria-label'));
        pushLink(href, text);
      }

      // 3) Image map areas
      const areas = Array.from(document.querySelectorAll<HTMLAreaElement>('area[href]'));
      for (const area of areas) {
        const text = cleanup(area.getAttribute('alt')) || cleanup(area.getAttribute('title'));
        pushLink(area.getAttribute('href'), text);
      }

      // 4) Elements with data-href
      const dataHrefEls = Array.from(document.querySelectorAll<HTMLElement>('[data-href]'));
      for (const el of dataHrefEls) {
        const text = cleanup(el.textContent) || cleanup(el.getAttribute('title')) || cleanup(el.getAttribute('aria-label'));
        pushLink(el.getAttribute('data-href'), text);
      }

      // 5) Elements with onclick that navigates
      const onclickEls = Array.from(document.querySelectorAll<HTMLElement>('[onclick]'));
      const extractFromOnclick = (s: string): string | null => {
        const str = s || '';
        // window.open('...'), location='...', location.href='...'
        const m1 = str.match(/window\.open\(\s*['"]([^'"]+)['"]/i);
        if (m1) return m1[1];
        const m2 = str.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
        if (m2) return m2[1];
        return null;
      };
      for (const el of onclickEls) {
        const href = extractFromOnclick(el.getAttribute('onclick') || '');
        if (!href) continue;
        const text = cleanup(el.textContent) || cleanup(el.getAttribute('title')) || cleanup(el.getAttribute('aria-label'));
        pushLink(href, text);
      }

      return links;
    });

    // Resolve to absolute URLs when possible
    const base = new URL(normalizedUrl);

    const toAbsolute = (href: string): string => {
      try {
        // URL with base correctly resolves relative paths
        return new URL(href, base).toString();
      } catch {
        // Fallback conservative handling
        if (/^\/\//.test(href)) {
          return `${base.protocol}${href}`;
        }
        if (/^\//.test(href)) {
          return `${base.origin}${href}`;
        }
        return href; // leave as-is
      }
    };

    // Deduplicate by final URL while preserving order
    const seen = new Set<string>();
    const resolved = rawLinks
      .map(({ href, title }) => ({ url: toAbsolute(href), title: title || "" }))
      .filter(({ url }) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });

    const resultText = JSON.stringify(
      { origin: base.origin, count: resolved.length, links: resolved },
      null,
      2
    );

    return {
      content: [{ type: "text", text: resultText }],
    };
  } finally {
    await browserService.cleanup(browser, page);
    if (browserService.isInDebugMode()) {
      logger.debug(`[GetLink] Browser and page kept open for debugging. URL: ${normalizedUrl}`);
    }
  }
}
