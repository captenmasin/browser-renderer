import { handler } from '../lambda/handler.js';

const targetUrl = process.env.TARGET_URL ?? 'https://example.com';
const token = process.env.RENDER_TOKEN;

if (!token) {
  console.error('RENDER_TOKEN is required.');
  process.exit(1);
}

const response = await handler({
  rawPath: '/content',
  requestContext: {
    http: {
      method: 'POST',
    },
  },
  headers: {
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    url: targetUrl,
    waitUntil: process.env.WAIT_UNTIL ?? 'networkidle2',
    timeout: Number.parseInt(process.env.NAV_TIMEOUT_MS ?? '30000', 10),
  }),
  isBase64Encoded: false,
});

console.log(JSON.stringify({
  statusCode: response.statusCode,
  bodyBytes: Buffer.byteLength(response.body ?? '', 'utf8'),
  contentBytes: response.statusCode === 200
    ? Buffer.byteLength(JSON.parse(response.body).content ?? '', 'utf8')
    : undefined,
  body: response.statusCode === 200 ? undefined : response.body,
}, null, 2));

if (response.statusCode < 200 || response.statusCode >= 300) {
  process.exit(1);
}
