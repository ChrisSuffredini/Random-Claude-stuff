// HLTV's Cloudflare protection now blocks the plain HTTP requests the
// `hltv` package's default got-scraping-based loadPage makes (confirmed:
// it fails on the very first request, before any rate-limiting could be
// involved). Real/stealth-browser rendering is the standard current
// workaround for HLTV scraping. This module provides a `loadPage`
// replacement — a single reused Chromium tab (via puppeteer-extra +
// the stealth plugin) — that can be handed to `HLTV.createInstance()`
// and to our own clutching-page fetcher.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CHALLENGE_MARKERS = ['Just a moment', 'Checking your browser', 'Enable JavaScript and cookies'];

// Set HLTV_HEADLESS=true once you've confirmed challenges pass reliably
// on your machine. Left visible by default so you can see/solve a
// Cloudflare checkbox challenge by hand if one appears.
function isHeadless() {
  return process.env.HLTV_HEADLESS === 'true';
}

let browserPromise;
let sharedPage;

async function getPage() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: isHeadless(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  const browser = await browserPromise;
  if (!sharedPage) {
    sharedPage = await browser.newPage();
    await sharedPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await sharedPage.setViewport({ width: 1280, height: 900 });
  }
  return sharedPage;
}

function looksLikeChallenge(html) {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

// Reuses one browser tab across the whole run (so Cloudflare's session
// cookie from an earlier solved challenge carries over to later
// requests) rather than a fresh headless request per page.
async function loadPageWithBrowser(url) {
  const page = await getPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  let html = await page.content();
  const waitBudgetMs = isHeadless() ? 20000 : 90000;
  const deadline = Date.now() + waitBudgetMs;
  let warned = false;
  while (looksLikeChallenge(html) && Date.now() < deadline) {
    if (!isHeadless() && !warned) {
      console.log('  [waiting] Cloudflare check is on screen — solve it in the browser window if it needs a click...');
      warned = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    html = await page.content();
  }
  return html;
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
}

module.exports = { loadPageWithBrowser, closeBrowser };
