#!/usr/bin/env node
// Load test harness for browser-renderer.
// Hits POST /content with the configured payload at a fixed concurrency
// for DURATION seconds, then prints a summary.
//
// Usage:
//   RENDER_URL=http://localhost:3000 \
//   RENDER_TOKEN=your-token \
//   TARGET_URL=https://example.com \
//   DURATION=30 CONCURRENCY=20 \
//   node scripts/loadtest.js

import autocannon from 'autocannon';

const RENDER_URL = process.env.RENDER_URL || 'http://localhost:3000';
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';
const TARGET_URL = process.env.TARGET_URL || 'https://example.com';
const DURATION = parseInt(process.env.DURATION || '30');
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10');
const WAIT_UNTIL = process.env.WAIT_UNTIL || 'networkidle0';
const TIMEOUT_SEC = parseInt(process.env.TIMEOUT_SEC || '60');

const headers = {
  'Content-Type': 'application/json',
};
if (RENDER_TOKEN) headers.Authorization = `Bearer ${RENDER_TOKEN}`;

console.log(`load test → ${RENDER_URL}/content`);
console.log(`  target:      ${TARGET_URL}`);
console.log(`  concurrency: ${CONCURRENCY}`);
console.log(`  duration:    ${DURATION}s`);
console.log(`  waitUntil:   ${WAIT_UNTIL}`);
console.log('');

const instance = autocannon({
  url: `${RENDER_URL}/content`,
  method: 'POST',
  headers,
  body: JSON.stringify({ url: TARGET_URL, waitUntil: WAIT_UNTIL }),
  connections: CONCURRENCY,
  duration: DURATION,
  timeout: TIMEOUT_SEC,
}, (err, result) => {
  if (err) {
    console.error('load test failed:', err);
    process.exit(1);
  }

  const non2xx = result['non2xx'] || 0;
  const reqs = result.requests;
  const lat = result.latency;

  console.log('\n=== summary ===');
  console.log(`requests:   ${reqs.total} total, ${reqs.average.toFixed(2)}/s avg`);
  console.log(`latency:    avg ${lat.average}ms · p50 ${lat.p50}ms · p95 ${lat.p97_5}ms · p99 ${lat.p99}ms · max ${lat.max}ms`);
  console.log(`statuses:   2xx=${reqs.total - non2xx}  non-2xx=${non2xx}  errors=${result.errors}  timeouts=${result.timeouts}`);
  console.log(`throughput: ${(result.throughput.average / 1024).toFixed(2)} KB/s`);

  if (non2xx > 0) {
    console.log('\n  > non-2xx > 0 — likely 503s from MAX_CONCURRENT semaphore. Lower CONCURRENCY or raise the cap.');
  }
  if (result.timeouts > 0) {
    console.log(`  > ${result.timeouts} timeouts — bump TIMEOUT_SEC or check the target site / NAV_TIMEOUT_MS.`);
  }
});

autocannon.track(instance, { renderProgressBar: true });
