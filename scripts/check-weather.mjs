// Thailand Weather Alert — GitHub Actions checker
// Zero dependencies (Node 20+). Data: Open-Meteo (forecast/current) + RainViewer (live radar echo).
// Evaluates 5 states per province: ok | rain | flood | heat | cold  (priority: flood > heat > rain > cold > ok)
// Sends a Discord embed only when a province STARTS or STOPS an alert state.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROVINCES = JSON.parse(await readFile(path.join(here, 'provinces.json'), 'utf8'));

// ───────────────────────── Config (override with env vars / repo Variables) ─────────────────────────
export function loadConfig(env = process.env) {
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    webhook: env.DISCORD_WEBHOOK || '',
    show: new Set((env.ALERT_STATUSES || 'flood,heat,rain').split(',').map(s => s.trim()).filter(Boolean)),
    heatIndexC: num('HEAT_INDEX_C', 40),        // "feels like" (apparent temperature) >= this => extreme heat
    coldC: num('COLD_C', 16),                   // air temperature <= this => cold
    radarMinPixels: num('RADAR_MIN_PIXELS', 3), // echo pixels (of 25 around the point) needed to count as radar rain
    useRadar: env.USE_RADAR !== '0',
    stateFile: env.STATE_FILE || '.state/state.json',
    dryRun: env.DRY_RUN === '1',                // print instead of posting to Discord / writing state
    testDiscord: env.TEST_DISCORD === '1',      // just send a test message
  };
}

// ───────────────────────── Rules ─────────────────────────
export function floodFlags(w) {
  const f = [], r6 = w.rain6h, r24 = w.rain24h, r72 = w.rain72h, mx = w.rainMax6;
  if (w.rain >= 15) f.push(`ฝนหนักมากตอนนี้ ${w.rain.toFixed(1)} มม./ชม.`);
  if (w.rain3h >= 30) f.push(`คาดฝน 3 ชม. ${w.rain3h.toFixed(0)} มม.`);
  if (r6 >= 50 || mx >= 20) f.push(`คาดฝน 6 ชม. ${r6.toFixed(0)} มม. (สูงสุด ${mx.toFixed(0)} มม./ชม.)`);
  if (r24 >= 90 || (r24 >= 60 && r6 >= 20)) f.push(`ฝนสะสม 24 ชม. ${r24.toFixed(0)} มม.`);
  if (r72 >= 150) f.push(`ฝนสะสม 72 ชม. ${r72.toFixed(0)} มม.`);
  return f;
}

export function classify(w, radarEcho, cfg) {
  if (floodFlags(w).length) return 'flood';
  if ((w.feels ?? w.temp) >= cfg.heatIndexC) return 'heat';
  if (w.rain >= 0.5 || w.rain3h >= 5 || radarEcho === true) return 'rain';
  if (w.temp <= cfg.coldC) return 'cold';
  return 'ok';
}

// ───────────────────────── HTTP helpers ─────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { 'User-Agent': 'thai-weather-alert/1.0 (github-actions)' };

async function fetchRetry(url, tries, parse) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (res.ok) return await parse(res);
      err = new Error('HTTP ' + res.status);
      if (res.status !== 429 && res.status < 500) break; // 4xx other than 429: retrying won't help
    } catch (e) { err = e; }
    if (i < tries - 1) await sleep(1500 * 2 ** i);
  }
  throw err;
}
const getJSON = (url, tries = 4) => fetchRetry(url, tries, r => r.json());
const getBuffer = (url, tries = 2) => fetchRetry(url, tries, async r => Buffer.from(await r.arrayBuffer()));

// ───────────────────────── Open-Meteo ─────────────────────────
const OM = 'https://api.open-meteo.com/v1/forecast?current=temperature_2m,apparent_temperature,precipitation'
  + '&hourly=precipitation&past_days=3&forecast_days=2&timezone=Asia%2FBangkok';

export function parseOM(j) {
  const c = j && j.current, h = j && j.hourly;
  if (!c || c.temperature_2m == null || !h || !h.time) return null;
  let i0 = h.time.findIndex(t => t >= c.time.slice(0, 13) + ':00'); if (i0 < 0) i0 = 0;
  const P = h.precipitation || [];
  const sum = (a, b) => P.slice(Math.max(0, a), Math.max(0, b)).reduce((s, x) => s + (x || 0), 0);
  return {
    temp: c.temperature_2m, feels: c.apparent_temperature ?? c.temperature_2m, rain: c.precipitation ?? 0,
    rain3h: sum(i0 + 1, i0 + 4), rain6h: sum(i0 + 1, i0 + 7),
    rain24h: sum(i0 - 23, i0 + 1), rain72h: sum(i0 - 71, i0 + 1),
    rainMax6: Math.max(0, ...P.slice(i0 + 1, i0 + 7).map(x => x || 0)),
  };
}

async function fetchWeather() {
  const out = new Map(), chunks = [];
  for (let i = 0; i < PROVINCES.length; i += 20) chunks.push(PROVINCES.slice(i, i + 20));
  const res = await Promise.allSettled(chunks.map(ch =>
    getJSON(`${OM}&latitude=${ch.map(p => p.lat).join(',')}&longitude=${ch.map(p => p.lon).join(',')}`)));
  res.forEach((r, ci) => {
    if (r.status !== 'fulfilled') { console.warn(`Open-Meteo chunk ${ci + 1} failed: ${r.reason.message}`); return; }
    const arr = Array.isArray(r.value) ? r.value : [r.value];
    chunks[ci].forEach((p, k) => { try { const w = parseOM(arr[k]); if (w) out.set(p.name, w); } catch { /* skip */ } });
  });
  if (!out.size) throw new Error('Open-Meteo returned no usable data');
  return out;
}

// ───────────────────────── RainViewer radar (live echo at each province) ─────────────────────────
// RainViewer's public tiles: past frames only, max zoom 7. We download the few z7 tiles covering Thailand
// and check whether pixels around each province centre are non-transparent (= radar echo present).
const RZ = 7, RSIZE = 256;

export function tileOf(lat, lon, z = RZ, size = RSIZE) {
  const n = 2 ** z, fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, px: Math.min(size - 1, Math.floor((fx - x) * size)), py: Math.min(size - 1, Math.floor((fy - y) * size)) };
}

// Minimal PNG decoder (non-interlaced) — only what we need: per-pixel alpha. Handles palette+tRNS, RGBA, gray+alpha.
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 8, ctype = 6, interlace = 0, plte = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; interlace = body[12]; }
    else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error('bad color type');
  if (ctype === 0 || ctype === 2) throw new Error('PNG has no alpha channel');
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8)), rowBytes = Math.ceil((width * channels * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)], src = y * (rowBytes + 1) + 1, dst = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0, b = y ? px[dst - rowBytes + i] : 0, c = i >= bpp && y ? px[dst - rowBytes + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + i] = v & 255;
    }
  }
  const alpha = (x, y) => {
    const row = y * rowBytes;
    if (ctype === 6) return px[row + x * 4 * (depth / 8) + 3 * (depth / 8)];
    if (ctype === 4) return px[row + x * 2 * (depth / 8) + depth / 8];
    const bit = x * depth, idx = (px[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1); // palette index
    return trns && idx < trns.length ? trns[idx] : 255;
  };
  return { width, height, alpha };
}

async function fetchRadar(weather, cfg) {
  const echo = new Map();
  try {
    const meta = await getJSON('https://api.rainviewer.com/public/weather-maps.json', 2);
    const frame = meta.radar && meta.radar.past && meta.radar.past.at(-1);
    if (!frame) throw new Error('no radar frames');
    const ageMin = (Date.now() / 1000 - frame.time) / 60;
    if (ageMin > 40) throw new Error(`latest radar frame is ${ageMin.toFixed(0)} min old — ignoring`);
    const tiles = new Map(), want = [];
    for (const p of PROVINCES) {
      if (!weather.has(p.name)) continue;
      const t = tileOf(p.lat, p.lon), key = `${t.x}/${t.y}`;
      if (!tiles.has(key)) tiles.set(key, getBuffer(`${meta.host}${frame.path}/${RSIZE}/${RZ}/${t.x}/${t.y}/2/0_0.png`).then(decodePng).catch(e => { console.warn(`radar tile ${key}: ${e.message}`); return null; }));
      want.push([p, t, key]);
    }
    for (const [p, t, key] of want) {
      const img = await tiles.get(key);
      if (!img) continue; // unknown for this province → falls back to Open-Meteo only
      let hits = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = t.px + dx, y = t.py + dy;
        if (x >= 0 && y >= 0 && x < img.width && y < img.height && img.alpha(x, y) > 0) hits++;
      }
      echo.set(p.name, hits >= cfg.radarMinPixels);
    }
  } catch (e) { console.warn('Radar check skipped:', e.message); }
  return echo;
}

// ───────────────────────── Discord ─────────────────────────
const COLORS = { flood: 0xf85149, heat: 0xdb6d28, rain: 0x4493f8, cold: 0x58a6ff, end: 0x3fb950 };
const LABEL = { flood: '🌊 เสี่ยงน้ำท่วม (Flood Risk)', heat: '🔥 ร้อนจัด (Extreme Heat)', rain: '🌧️ ฝนตก (Rain)', cold: '❄️ หนาว (Cold)' };
const ENDTXT = { flood: 'หมดความเสี่ยงน้ำท่วมแล้ว', heat: 'ร้อนจัดลดลงแล้ว', rain: 'ฝนหยุดตกแล้ว', cold: 'อากาศอุ่นขึ้นแล้ว' };

function detail(st, w, radar) {
  if (st === 'flood') return floodFlags(w).join(' • ');
  if (st === 'heat') return `ความรู้สึกร้อน ${w.feels.toFixed(1)}°C (อุณหภูมิ ${w.temp.toFixed(1)}°C)`;
  if (st === 'cold') return `${w.temp.toFixed(1)}°C`;
  if (w.rain >= 0.5) return `ฝน ${w.rain.toFixed(1)} มม./ชม.${radar ? ' • 📡 เรดาร์ยืนยัน' : ''}`;
  if (w.rain3h >= 5) return `คาดฝน 3 ชม. ${w.rain3h.toFixed(1)} มม.${radar ? ' • 📡 เรดาร์พบฝน' : ''}`;
  return '📡 เรดาร์พบกลุ่มฝนใกล้จังหวัด';
}

const clock = () => new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

function embedsFor(title, lines, color) { // long lists split into several embeds, never truncated
  const out = []; let buf = [], len = 0;
  const flush = () => { if (buf.length) out.push({ title: out.length ? title + ' (ต่อ)' : title, description: buf.join('\n'), color }); buf = []; len = 0; };
  for (const l of lines) { if (len + l.length > 3500) flush(); buf.push(l); len += l.length + 1; }
  flush(); return out;
}

export function buildMessages(start, end) {
  const embeds = [];
  for (const st of ['flood', 'heat', 'rain', 'cold']) {
    const items = start.filter(a => a.st === st).sort((a, b) => a.name.localeCompare(b.name, 'th'));
    if (items.length) embeds.push(...embedsFor(`${LABEL[st]} — ${items.length} จังหวัด`,
      items.map(a => `${st === 'flood' ? '❗ ' : ''}**${a.name}** — ${detail(st, a.w, a.radar)}`), COLORS[st]));
  }
  if (end.length) embeds.push(...embedsFor(`✅ กลับสู่ปกติ — ${end.length} รายการ`, end.map(a => `✅ **${a.name}** — ${ENDTXT[a.st]}`), COLORS.end));
  const msgs = []; let cur = [], size = 0; // Discord: ≤10 embeds and ≤6000 chars per message
  for (const e of embeds) {
    const s = e.title.length + e.description.length;
    if (cur.length && (cur.length >= 10 || size + s > 5500)) { msgs.push(cur); cur = []; size = 0; }
    cur.push(e); size += s;
  }
  if (cur.length) msgs.push(cur);
  const floods = start.filter(a => a.st === 'flood').map(a => a.name);
  return msgs.map((embs, i) => {
    const last = embs[embs.length - 1];
    last.footer = { text: 'Open-Meteo • RainViewer • GitHub Actions' };
    last.timestamp = new Date().toISOString();
    const content = i ? `(ต่อ ${i + 1}/${msgs.length})`
      : `🚨 **Thailand Weather Alert** • ${clock()} น.` + (floods.length ? `\n❗ เสี่ยงน้ำท่วม: ${floods.join(', ')}` : '');
    return { username: 'Thai Weather Alert', content: content.slice(0, 2000), embeds: embs, allowed_mentions: { parse: [] } };
  });
}

async function post(cfg, body) {
  if (cfg.dryRun) { console.log('[DRY_RUN] Discord payload:\n' + JSON.stringify(body, null, 2)); return; }
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(cfg.webhook)) throw new Error('DISCORD_WEBHOOK secret is missing or not a Discord webhook URL');
  const opt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) };
  let res = await fetch(cfg.webhook, opt);
  if (res.status === 429) { const j = await res.json().catch(() => ({})); await sleep(Math.min((j.retry_after || 1) * 1000, 10000)); res = await fetch(cfg.webhook, opt); }
  if (!res.ok) throw new Error('Discord responded HTTP ' + res.status);
}

// ───────────────────────── Main ─────────────────────────
async function readState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')).s || {}; } catch { return {}; }
}

export async function run(cfg = loadConfig()) {
  if (cfg.testDiscord) {
    await post(cfg, { username: 'Thai Weather Alert', content: '🧪 ทดสอบ — GitHub Actions ส่งข้อความเข้า Discord ได้แล้ว ✅' });
    return 'test message sent';
  }
  const prev = await readState(cfg.stateFile);
  const weather = await fetchWeather();
  const radar = cfg.useRadar ? await fetchRadar(weather, cfg) : new Map();

  const next = {}, start = [], end = [], counts = { ok: 0, rain: 0, flood: 0, heat: 0, cold: 0 };
  for (const p of PROVINCES) {
    const w = weather.get(p.name), o = prev[p.name];
    if (!w) { if (o) next[p.name] = o; continue; } // no data this round → keep previous state
    let st = classify(w, radar.get(p.name), cfg), n = 0;
    counts[st]++;
    // An alert only "ends" after 2 consecutive calm readings (avoids flapping). Alert→alert changes are instant.
    if (o && cfg.show.has(o.st) && !cfg.show.has(st) && o.st !== st && !(o.n >= 1)) { st = o.st; n = 1; }
    next[p.name] = { st, n };
    const old = o && o.st;
    if (st === old) continue;
    if (old && cfg.show.has(old) && !cfg.show.has(st)) end.push({ name: p.name, st: old });
    if (cfg.show.has(st)) start.push({ name: p.name, st, w, radar: radar.get(p.name) });
  }

  for (const body of buildMessages(start, end)) { await post(cfg, body); await sleep(700); } // throws before state is saved → retried next run
  if (!cfg.dryRun) {
    await mkdir(path.dirname(cfg.stateFile), { recursive: true });
    await writeFile(cfg.stateFile, JSON.stringify({ t: Date.now(), s: next }));
  }

  const line = `ok ${counts.ok} • rain ${counts.rain} • flood ${counts.flood} • heat ${counts.heat} • cold ${counts.cold} | started ${start.length}, ended ${end.length}` +
    ` | radar ${radar.size ? 'on' : 'off'}`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Weather check\n${line}\n`).catch(() => {});
  return line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const t0 = Date.now();
  run().then(r => console.log(`${r} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
