// Offline tests: node scripts/test.mjs   (no network — fetch is mocked)
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classify, floodFlags, loadConfig, tileOf, decodePng, parseOM, buildMessages, run, PROVINCES } from './check-weather.mjs';

const cfg = loadConfig({});
const W = (o = {}) => ({ temp: 30, feels: 33, rain: 0, rain3h: 0, rain6h: 0, rain24h: 0, rain72h: 0, rainMax6: 0, ...o });

// ── classify ──
assert.equal(classify(W(), false, cfg), 'ok');
assert.equal(classify(W({ rain: 1 }), false, cfg), 'rain');
assert.equal(classify(W({ rain3h: 6 }), false, cfg), 'rain');
assert.equal(classify(W(), true, cfg), 'rain');                       // radar echo only
assert.equal(classify(W({ feels: 41 }), false, cfg), 'heat');
assert.equal(classify(W({ feels: 41, rain: 2 }), false, cfg), 'heat'); // heat outranks rain
assert.equal(classify(W({ temp: 15, feels: 15 }), false, cfg), 'cold');
assert.equal(classify(W({ rain24h: 95 }), false, cfg), 'flood');
assert.equal(classify(W({ rain6h: 55, feels: 45 }), true, cfg), 'flood'); // flood outranks all
assert.ok(floodFlags(W({ rain72h: 160 })).length === 1);

// ── tile math: Bangkok at z7 ──
const t = tileOf(13.7563, 100.5018);
assert.deepEqual([t.x, t.y], [99, 59]); // 100.50°E → 99.73, 13.76°N → 59.06 at z7

// ── PNG: build a palette+tRNS tile with a 6x6 echo blob around (128,128) ──
const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
function makePng(blob) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 3;
  const rows = [];
  for (let y = 0; y < 256; y++) { const r = Buffer.alloc(257); for (let x = 0; x < 256; x++) r[1 + x] = blob && x >= 125 && x < 131 && y >= 125 && y < 131 ? 1 : 0; rows.push(r); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from([0, 0, 0, 0, 120, 255])), chunk('tRNS', Buffer.from([0, 255])),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const img = decodePng(makePng(true));
assert.equal(img.alpha(128, 128), 255); assert.equal(img.alpha(10, 10), 0);

// ── parseOM: index math (current = 10:00 on day 4 of a 120-hour series) ──
const hours = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2026, 9, 8, i)).toISOString().slice(0, 13) + ':00');
const omOne = (rainFn, cur = {}) => ({ current: { time: '2026-10-11T10:00', temperature_2m: 30, apparent_temperature: 34, precipitation: 0, ...cur },
  hourly: { time: hours, precipitation: hours.map((_, i) => rainFn(i)) } });
const p = parseOM(omOne(i => (i === 83 ? 12 : 0)));
assert.equal(p.rain3h, 12); assert.equal(p.rainMax6, 12);

// ── buildMessages: splitting + limits with every province alerting ──
const all = PROVINCES.map(x => ({ name: x.name, st: 'rain', w: W({ rain: 2 }), radar: true }));
const msgs = buildMessages(all, all.map(a => ({ name: a.name, st: 'flood' })));
for (const m of msgs) {
  assert.ok(m.embeds.length <= 10);
  assert.ok(m.embeds.reduce((s, e) => s + e.title.length + e.description.length + (e.footer?.text.length || 0), 0) <= 6000);
}

// ── integration with mocked network ──
let scenario = 'rain', sent = [];
globalThis.fetch = async (url, opt) => {
  url = String(url);
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('open-meteo')) {
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const rainy = scenario === 'rain', rf = rainy ? (i => (i === 82 ? 3 : 0)) : () => 0;
    return json(Array.from({ length: n }, () => omOne(rf, { precipitation: rainy ? 3 : 0 })));
  }
  if (url.includes('weather-maps.json')) return json({ host: 'https://tilecache.test', radar: { past: [{ time: Math.floor(Date.now() / 1000) - 300, path: '/v2/radar/1' }] } });
  if (url.startsWith('https://tilecache.test')) return new Response(makePng(false), { status: 200 });
  if (url.includes('discord.com/api/webhooks')) { sent.push(JSON.parse(opt.body)); return new Response(null, { status: 204 }); }
  throw new Error('unexpected fetch ' + url);
};
const dir = await mkdtemp(path.join(tmpdir(), 'wx-'));
const c = loadConfig({ DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/abc', STATE_FILE: path.join(dir, 's.json') });

scenario = 'rain';  let r = await run(c);
assert.match(r, /rain 77/); assert.match(r, /started 77/); assert.ok(sent.length >= 1, 'start notification sent');
const afterStart = sent.length;
r = await run(c);   assert.match(r, /started 0, ended 0/); assert.equal(sent.length, afterStart, 'no repeat alert while still raining');
scenario = 'calm';  r = await run(c);
assert.match(r, /ended 0/); assert.equal(sent.length, afterStart, 'first calm reading is debounced');
r = await run(c);   assert.match(r, /ended 77/); assert.ok(sent.length > afterStart, 'end notification after 2nd calm reading');
assert.ok(sent.at(-1).embeds[0].title.startsWith('✅'));
console.log('All tests passed ✔  (Discord messages sent in mock:', sent.length + ')');
