// server.js
import express from 'express';
import puppeteer from 'puppeteer';

const PORT = 3000;
const TOKEN = process.env.RENDER_TOKEN;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '40');
const NAV_TIMEOUT_MS = 30_000;
const PAGE_CONTENT_TIMEOUT_MS = 5_000;

let browser;
let active = 0;

async function getBrowser() {
  if (browser?.connected) return browser;
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',     // avoid /dev/shm OOM
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote',
      '--single-process',            // try without first; some sites need multi-process
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  return browser;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_, res) => res.json({ ok: true, active }));

app.post('/content', async (req, res) => {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (active >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'overloaded', retryAfter: 1 });
  }
  const { url, waitUntil = 'networkidle0', timeout = NAV_TIMEOUT_MS } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  active++;
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Block heavy resources crawler doesn't need for link extraction
    await page.setRequestInterception(true);
    page.on('request', r => {
      const t = r.resourceType();
      if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') {
        return r.abort();
      }
      r.continue();
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

app.listen(PORT, '0.0.0.0', () => console.log(`render up on :${PORT}`));
