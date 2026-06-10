// server.js
import express from 'express';
import puppeteer from 'puppeteer';

const PORT = 3000;
const TOKEN = process.env.RENDER_TOKEN;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '40');
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '30000');
const PAGE_CONTENT_TIMEOUT_MS = 5_000;
const BROWSER_MAX_RENDERS = parseInt(process.env.BROWSER_MAX_RENDERS || '1000');
const BROWSER_MAX_AGE_MS = parseInt(process.env.BROWSER_MAX_AGE_MS || `${60 * 60 * 1000}`);
const DEFAULT_WAIT_UNTIL = 'networkidle2';
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

let browser;
let browserStartedAt = 0;
let browserRenders = 0;
let active = 0;
let browserUsers = 0;
let shuttingDown = false;
let browserLaunchPromise;

async function getBrowser() {
  const tooOld = browserStartedAt > 0 && (Date.now() - browserStartedAt > BROWSER_MAX_AGE_MS);
  const tooManyRenders = browserRenders >= BROWSER_MAX_RENDERS;

  if (browser?.connected && !tooOld && !tooManyRenders && !browserLaunchPromise) {
    return leaseBrowser(browser);
  }

  if (!browserLaunchPromise) {
    browserLaunchPromise = launchBrowser().finally(() => {
      browserLaunchPromise = undefined;
    });
  }

  return leaseBrowser(await browserLaunchPromise);
}

function leaseBrowser(activeBrowser) {
  browserUsers++;

  return {
    browser: activeBrowser,
    release() {
      browserUsers--;
    },
  };
}

async function launchBrowser() {
  while (browser && browserUsers > 0) {
    await new Promise(r => setTimeout(r, 100));
  }

  if (browser) {
    try { await browser.close(); } catch {}
    browser = undefined;
  }

  browser = await puppeteer.launch({
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  browserStartedAt = Date.now();
  browserRenders = 0;
  return browser;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', async (_, res) => {
  const alive = browser?.connected === true;
  res.status(alive ? 200 : 503).json({
    ok: alive,
    active,
    browserUsers,
    renders: browserRenders,
    uptimeMs: browser ? Date.now() - browserStartedAt : 0,
  });
});

app.post('/content', async (req, res) => {
  if (shuttingDown) return res.status(503).json({ error: 'shutting down' });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'overloaded', retryAfter: 1 });
  }
  const { url, waitUntil = DEFAULT_WAIT_UNTIL, timeout = NAV_TIMEOUT_MS, userAgent } = req.body || {};
  const validatedUrl = validateUrl(url);
  if (!validatedUrl.ok) return res.status(400).json({ error: validatedUrl.error });

  active++;
  let page;
  let browserLease;
  try {
    browserLease = await getBrowser();
    const b = browserLease.browser;
    page = await b.newPage();
    browserRenders++;
    if (userAgent) await page.setUserAgent(userAgent);

    await page.setRequestInterception(true);
    page.on('request', r => {
      try {
        if (BLOCKED_RESOURCE_TYPES.has(r.resourceType())) {
          return r.abort();
        }
        r.continue();
      } catch { /* request already handled */ }
    });

    await page.goto(validatedUrl.url, { waitUntil, timeout: normalizeTimeout(timeout) });
    const content = await page.content({ timeout: PAGE_CONTENT_TIMEOUT_MS });
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
    if (browserLease) browserLease.release();
    active--;
  }
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutting down...');
  const deadline = Date.now() + 30_000;
  while (active > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (browser) { try { await browser.close(); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, '0.0.0.0', () => console.log(`render up on :${PORT}`));

function validateUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, error: 'url required' };
  }

  try {
    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: 'unsupported url protocol' };
    }

    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: 'invalid url' };
  }
}

function normalizeTimeout(timeout) {
  const parsed = Number.parseInt(timeout, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return NAV_TIMEOUT_MS;
  }

  return Math.min(parsed, 60_000);
}
