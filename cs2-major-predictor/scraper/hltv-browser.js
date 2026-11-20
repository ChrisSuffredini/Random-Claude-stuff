// Fetches HLTV pages through a real Chrome/Chromium that YOU started and
// cleared Cloudflare in (same "attach mode" as ../cs2-time-alive).
//
// Speed trick: once the tab is on hltv.org with a valid cf_clearance
// cookie, pages are pulled with an in-page fetch() instead of a full
// navigation. No images, ads or scripts get loaded, so a page takes a few
// hundred ms instead of several seconds. If Cloudflare refuses a fetch(),
// we fall back to a real navigation for that URL, so you can solve the
// challenge in the window, and then go back to the fast path.
const puppeteer = require('puppeteer-core');

const CHALLENGE_MARKERS = [
  'Just a moment...',
  'Checking your browser',
  'Enable JavaScript and cookies to continue',
  'cf-challenge',
  'challenge-platform',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function looksLikeChallenge(html) {
  // Real HLTV pages are big; challenge pages are small. Only treat the
  // markers as a challenge on a small page, because the real site also
  // loads Cloudflare's challenge-platform script.
  return html.length < 60000 && CHALLENGE_MARKERS.some((m) => html.includes(m));
}

class HltvBrowser {
  constructor({ cdpUrl, base = 'https://www.hltv.org', minDelayMs = 700, maxDelayMs = 1400, log = console.log } = {}) {
    if (!cdpUrl) {
      throw new Error(
        'HLTV_CDP_URL is not set. Start Chromium with --remote-debugging-port=9222, ' +
          'clear the Cloudflare check on hltv.org in it, then run with HLTV_CDP_URL=http://127.0.0.1:9222'
      );
    }
    this.cdpUrl = cdpUrl;
    this.base = base;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.log = log;
    this.fastPathOk = true;
    this.fastFailures = 0;
    this.lastRequestAt = 0;
  }

  async init() {
    this.browser = await puppeteer.connect({ browserURL: this.cdpUrl, defaultViewport: null });
    // A tab of our own, in the same profile, so the cf_clearance cookie you
    // earned carries over but your tab is left alone.
    this.page = await this.browser.newPage();
    await this.navigate(`${this.base}/`);
  }

  async pace() {
    const wait = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < wait) await sleep(wait - elapsed);
    this.lastRequestAt = Date.now();
  }

  // Full navigation: slow, but lets a human clear a challenge.
  async navigate(url) {
    const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      this.log(`  [warn] navigation error: ${e.message}`);
      return null;
    });
    let html = await this.page.content();
    let warned = false;
    const deadline = Date.now() + 180000;
    while (looksLikeChallenge(html) && Date.now() < deadline) {
      if (!warned) {
        this.log('  [waiting] Cloudflare check on screen: solve it in the browser window (up to 3 min)...');
        warned = true;
      }
      await sleep(2000);
      html = await this.page.content();
    }
    // Let the post-challenge redirect settle into the real page.
    const settle = Date.now() + 15000;
    while (Date.now() < settle && (html.length < 5000 || looksLikeChallenge(html))) {
      await sleep(500);
      html = await this.page.content();
    }
    return { status: resp ? resp.status() : 0, finalUrl: this.page.url(), html };
  }

  async fastFetch(url) {
    // Must run from an hltv.org page (same origin, so cookies are sent).
    if (!this.page.url().startsWith(this.base)) {
      await this.navigate(`${this.base}/`);
    }
    return this.page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include', redirect: 'follow' });
      return { status: r.status, finalUrl: r.url, html: await r.text() };
    }, url);
  }

  // Returns { status, finalUrl, html, via }.
  async get(url) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await this.pace();
      let res;
      if (this.fastPathOk) {
        try {
          res = await this.fastFetch(url);
          res.via = 'fetch';
        } catch (e) {
          this.log(`  [warn] in-page fetch failed (${e.message}); using navigation`);
          res = null;
        }
        if (res && (res.status === 403 || res.status === 503 || looksLikeChallenge(res.html))) {
          this.fastFailures++;
          if (this.fastFailures >= 3) {
            this.log('  [info] Cloudflare keeps refusing in-page fetches; switching to page navigation for the rest of the run');
            this.fastPathOk = false;
          }
          res = null;
        }
      }
      if (!res) {
        res = await this.navigate(url);
        res.via = 'navigate';
      }
      if (res.status === 429) {
        const wait = 30000 * attempt;
        this.log(`  [rate-limited] HTTP 429, waiting ${wait / 1000}s before retrying`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < 4) {
        this.log(`  [retry] HTTP ${res.status}, retrying`);
        await sleep(5000 * attempt);
        continue;
      }
      if (res.via === 'fetch' && res.status === 200) this.fastFailures = 0;
      return res;
    }
    throw new Error(`giving up on ${url}`);
  }

  async close() {
    try {
      if (this.page) await this.page.close();
    } catch (_) {
      /* tab already gone */
    }
    // Never quit a browser we did not start: disconnect only.
    if (this.browser) await this.browser.disconnect();
  }
}

module.exports = { HltvBrowser, looksLikeChallenge };
