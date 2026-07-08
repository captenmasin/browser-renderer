import crypto from 'node:crypto';

import chromium from '@sparticuz/chromium';
import lighthouse from 'lighthouse';
import puppeteer from 'puppeteer-core';

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_CONTENT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_UNTIL = 'networkidle2';
const DEFAULT_MAX_RESPONSE_BYTES = 5_500_000;
const DEFAULT_BROWSER_MAX_RENDERS = 100;
const DEFAULT_BROWSER_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_LIGHTHOUSE_TIMEOUT_MS = 120_000;
const DEFAULT_VIEWPORT = {
  deviceScaleFactor: 1,
  hasTouch: false,
  height: 1080,
  isLandscape: true,
  isMobile: false,
  width: 1920,
};
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

let browser;
let browserStartedAt = 0;
let browserRenders = 0;
let browserLaunchPromise;
let lighthouseActive = false;

export async function handler(event) {
  return handleEvent(event);
}

export async function handleEvent(event, options = {}) {
  const method = getMethod(event);
  const path = getPath(event);

  if (method === 'GET' && path === '/healthz') {
    return jsonResponse(200, {
      ok: true,
      browserConnected: browser?.connected === true,
      renders: browserRenders,
      uptimeMs: browser ? Date.now() - browserStartedAt : 0,
    });
  }

  if (method !== 'POST' || !['/content', '/lighthouse'].includes(path)) {
    return jsonResponse(404, { error: 'not found' });
  }

  const token = options.token ?? process.env.RENDER_TOKEN;
  if (!token) {
    log('renderer_not_configured');

    return jsonResponse(500, { error: 'renderer token not configured' });
  }

  if (!isAuthorized(event.headers ?? {}, token)) {
    log('unauthorized');

    return jsonResponse(401, { error: 'unauthorized' });
  }

  const body = parseJsonBody(event);
  if (!body.ok) {
    return jsonResponse(400, { error: body.error });
  }

  const defaultTimeout = Number.parseInt(process.env.NAV_TIMEOUT_MS ?? `${DEFAULT_NAV_TIMEOUT_MS}`, 10);
  const { url, waitUntil = DEFAULT_WAIT_UNTIL, timeout = defaultTimeout, userAgent } = body.value;
  const validatedUrl = validateUrl(url);
  if (!validatedUrl.ok) {
    return jsonResponse(400, { error: validatedUrl.error });
  }

  if (path === '/lighthouse') {
    return handleLighthouseRequest(validatedUrl.url, options);
  }

  const startedAt = Date.now();

  try {
    const renderUrl = options.renderUrl ?? defaultRenderUrl;
    const content = await renderUrl(validatedUrl.url, {
      waitUntil,
      timeout: normalizeTimeout(timeout),
      userAgent,
    });

    const maxResponseBytes = Number.parseInt(
      options.maxResponseBytes ?? process.env.MAX_RESPONSE_BYTES ?? `${DEFAULT_MAX_RESPONSE_BYTES}`,
      10,
    );
    const payload = { content };
    const responseBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

    if (responseBytes > maxResponseBytes) {
      log('content_too_large', {
        url: validatedUrl.url,
        responseBytes,
        maxResponseBytes,
        durationMs: Date.now() - startedAt,
      });

      return jsonResponse(502, {
        error: 'rendered content too large',
        responseBytes,
        maxResponseBytes,
      });
    }

    log('render_success', {
      url: validatedUrl.url,
      responseBytes,
      durationMs: Date.now() - startedAt,
    });

    return jsonResponse(200, payload);
  } catch (error) {
    log('render_failed', {
      url: validatedUrl.url,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });

    return jsonResponse(500, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleLighthouseRequest(url, options) {
  if (lighthouseActive) {
    return jsonResponse(503, { error: 'lighthouse already running', retryAfter: 1 });
  }

  const timeoutMs = normalizeLighthouseTimeout(
    options.lighthouseTimeoutMs ?? process.env.LIGHTHOUSE_TIMEOUT_MS ?? `${DEFAULT_LIGHTHOUSE_TIMEOUT_MS}`,
  );
  const startedAt = Date.now();
  lighthouseActive = true;

  try {
    const lighthouseRunner = options.lighthouseRunner ?? defaultRunLighthouse;
    const lighthouseResult = await withTimeout(
      lighthouseRunner(url, { timeoutMs }),
      timeoutMs,
      'lighthouse timed out',
    );
    const durationMs = Date.now() - startedAt;

    log('lighthouse_success', { url, durationMs });

    return jsonResponse(200, {
      lighthouseResult,
      durationMs,
      source: 'browser-renderer',
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = error?.code === 'ETIMEDOUT' ? 504 : 500;

    log('lighthouse_failed', { url, error: message, durationMs });

    return jsonResponse(statusCode, { error: message });
  } finally {
    lighthouseActive = false;
  }
}

async function defaultRunLighthouse(url, { timeoutMs }) {
  const activeBrowser = await getBrowser();
  browserRenders++;

  const result = await lighthouse(url, {
    logLevel: 'error',
    maxWaitForLoad: timeoutMs,
    onlyCategories: ['performance'],
    output: 'json',
    port: getBrowserDebugPort(activeBrowser),
  });

  if (!result?.lhr) {
    throw new Error('lighthouse did not return a result');
  }

  return result.lhr;
}

async function defaultRenderUrl(url, { waitUntil, timeout, userAgent }) {
  const activeBrowser = await getBrowser();
  browserRenders++;

  let page;

  try {
    page = await activeBrowser.newPage();

    if (userAgent) {
      await page.setUserAgent(userAgent);
    }

    await page.setRequestInterception(true);
    page.on('request', request => {
      try {
        if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
          request.abort();

          return;
        }

        request.continue();
      } catch {
        // Puppeteer may emit late request events during page shutdown.
      }
    });

    await page.goto(url, { waitUntil, timeout });

    return await page.content({ timeout: DEFAULT_PAGE_CONTENT_TIMEOUT_MS });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Closing failures should not mask the render result.
      }
    }
  }
}

async function getBrowser() {
  const browserMaxRenders = Number.parseInt(
    process.env.BROWSER_MAX_RENDERS ?? `${DEFAULT_BROWSER_MAX_RENDERS}`,
    10,
  );
  const browserMaxAgeMs = Number.parseInt(
    process.env.BROWSER_MAX_AGE_MS ?? `${DEFAULT_BROWSER_MAX_AGE_MS}`,
    10,
  );
  const tooOld = browserStartedAt > 0 && Date.now() - browserStartedAt > browserMaxAgeMs;
  const tooManyRenders = browserRenders >= browserMaxRenders;

  if (browser?.connected && !tooOld && !tooManyRenders) {
    return browser;
  }

  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  browserLaunchPromise = launchBrowser().finally(() => {
    browserLaunchPromise = undefined;
  });

  return browserLaunchPromise;
}

async function launchBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Best effort recycle before launching a fresh browser.
    }
  }

  browser = await puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
    defaultViewport: DEFAULT_VIEWPORT,
    executablePath: await chromium.executablePath(),
    headless: 'shell',
    ignoreHTTPSErrors: true,
  });
  browserStartedAt = Date.now();
  browserRenders = 0;

  return browser;
}

function isAuthorized(headers, token) {
  const authorization = getHeader(headers, 'authorization');
  const expected = `Bearer ${token}`;

  if (!authorization) {
    return false;
  }

  const actualBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

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

function parseJsonBody(event) {
  if (!event.body) {
    return { ok: true, value: {} };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    const value = JSON.parse(rawBody);

    return value && typeof value === 'object'
      ? { ok: true, value }
      : { ok: false, error: 'json object required' };
  } catch {
    return { ok: false, error: 'invalid json' };
  }
}

function normalizeTimeout(timeout) {
  const parsed = Number.parseInt(timeout, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_NAV_TIMEOUT_MS;
  }

  return Math.min(parsed, 60_000);
}

function normalizeLighthouseTimeout(timeout) {
  const parsed = Number.parseInt(timeout, 10);

  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_LIGHTHOUSE_TIMEOUT_MS : parsed;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = 'ETIMEDOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function getBrowserDebugPort(activeBrowser) {
  const port = Number.parseInt(new URL(activeBrowser.wsEndpoint()).port, 10);

  if (Number.isNaN(port)) {
    throw new Error('browser debug port unavailable');
  }

  return port;
}

function getMethod(event) {
  return event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
}

function getPath(event) {
  return event.rawPath ?? event.path ?? '/';
}

function getHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  const headerName = Object.keys(headers).find(key => key.toLowerCase() === normalizedName);

  return headerName ? headers[headerName] : undefined;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
}

function log(event, context = {}) {
  console.log(JSON.stringify({
    event,
    ...context,
  }));
}
