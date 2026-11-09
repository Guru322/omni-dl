#!/usr/bin/env node
/**
 * Quick smoke test against the running API:
 *   node test.js [url]
 */
const BASE = process.env.BASE_URL || 'http://localhost:4321';
const url = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`health: ${JSON.stringify(await (await fetch(`${BASE}/api/health`)).json())}`);

  console.log(`\ninfo for ${url}`);
  const info = await (await fetch(`${BASE}/api/info?url=${encodeURIComponent(url)}`)).json();
  if (info.error) return console.log('info error:', info.detail || info.error);
  console.log(`  ${info.extractor}: ${info.title}`);
  console.log(`  ${info.formats?.length ?? 0} formats`);

  console.log('\nqueueing download (720p mp4, capped 10s poll)...');
  const job = await (await fetch(`${BASE}/api/download`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, format: 'mp4', quality: '720' }),
  })).json();
  console.log(`  job ${job.id} -> ${job.status}`);

  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    await sleep(1500);
    last = await (await fetch(`${BASE}/api/jobs/${job.id}`)).json();
    process.stdout.write(`  ${last.status} ${last.progress ?? 0}% ${last.eta ?? ''}\r`);
    if (['done', 'error', 'cancelled'].includes(last.status)) break;
  }
  console.log(`\n  final: ${last.status} ${(last.error ?? '')}`);

  if (last.status === 'done') {
    const head = await fetch(`${BASE}/api/jobs/${job.id}/file`, { method: 'HEAD' }).catch(() => null);
    console.log(`  file endpoint: ${head?.status}`); // 200 expected
    console.log(`  file path on disk: ${last.filePath}`);
  }
})();
