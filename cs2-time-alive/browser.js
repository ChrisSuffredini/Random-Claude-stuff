// HLTV's Cloudflare protection blocks the plain HTTP requests the `hltv`
// package's default got-scraping-based loadPage makes, and also re-issues
// its challenge indefinitely against a Puppeteer-launched browser even
// with the stealth plugin (synthetic clicks get flagged, so solving the
// checkbox by hand in an automated window doesn't help).
//
// So the reliable path is ATTACH mode: you start a normal Chrome/Chromium
// yourself with remote debugging on, solve any Cloudflare check in it with
// your own mouse, and this module connects to that already-trusted session
// and drives navigation in it. Set HLTV_CDP_URL to enable it (see README).
//
// Without HLTV_CDP_URL it falls back to launching its own browser, which
// only works where Cloudflare isn't challenging.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CHALLENGE_MARKERS = ['Just a moment', 'Checking your browser', 'Enable JavaScript and cookies'];

function cdpUrl() {
  return process.env.HLTV_CDP_URL;
}

function isHeadless() {
  return process.env.HLTV_HEADLESS === 'true';
}

let browserPromise;
let sharedPage;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = cdpUrl()
      ? puppeteer.connect({ browserURL: cdpUrl() })
      : puppeteer.launch({
          headless: isHeadless(),
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
  }
  return browserPromise;
}

async function getPage() {
  const browser = await getBrowser();
  if (!sharedPage) {
    if (cdpUrl()) {
      // Reuse the tab you already solved the Cloudflare check in, so its
      // cf_clearance cookie and session carry into every fetch.
      const pages = await browser.pages();
      sharedPage = pages[0] || (await browser.newPage());
    } else {
      sharedPage = await browser.newPage();
      await sharedPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      );
      await sharedPage.setViewport({ width: 1280, height: 900 });
    }
  }
  return sharedPage;
}

function looksLikeChallenge(html) {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

// Reuses one tab across the whole run so a solved Cloudflare session
// carries over between requests.
async function loadPageWithBrowser(url) {
  const page = await getPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  let html = await page.content();
  const interactive = Boolean(cdpUrl()) || !isHeadless();
  const deadline = Date.now() + (interactive ? 90000 : 20000);
  let warned = false;
  while (looksLikeChallenge(html) && Date.now() < deadline) {
    if (interactive && !warned) {
      console.log('  [waiting] Cloudflare check is on screen — solve it in the browser window with your own mouse...');
      warned = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    html = await page.content();
  }
  return html;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  // Never kill a browser we didn't start — it's the user's own window.
  if (cdpUrl()) {
    await browser.disconnect();
  } else {
    await browser.close();
  }
}

module.exports = { loadPageWithBrowser, closeBrowser };
