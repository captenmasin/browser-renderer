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

let browser;
let browserStartedAt = 0;
let browserRenders = 0;
let active = 0;
let shuttingDown = false;
let recycling = false;

async function getBrowser() {
  const tooOld = browserStartedAt > 0 && (Date.now() - browserStartedAt > BROWSER_MAX_AGE_MS);
  const tooManyRenders = browserRenders >= BROWSER_MAX_RENDERS;

  if (browser?.connected && !tooOld && !tooManyRenders) return browser;

  // Recycle: don't tear down while requests in flight
  if (browser && !recycling && (tooOld || tooManyRenders)) {
    recycling = true;
    while (active > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
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
  recycling = false;
  return browser;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', async (_, res) => {
  const alive = browser?.connected === true;
  res.status(alive ? 200 : 503).json({
    ok: alive,
    active,
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
  const { url, waitUntil = 'networkidle0', timeout = NAV_TIMEOUT_MS, userAgent } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  active++;
  browserRenders++;
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    if (userAgent) await page.setUserAgent(userAgent);

    await page.setRequestInterception(true);
    page.on('request', r => {
      try {
        const t = r.resourceType();
        if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') {
          return r.abort();
        }
        r.continue();
      } catch { /* request already handled */ }
    });

    await page.goto(url, { waitUntil, timeout });
    const content = await page.content({ timeout: PAGE_CONTENT_TIMEOUT_MS });
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    if (page) { try { await page.close(); } catch {} }
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
