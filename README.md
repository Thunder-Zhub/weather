# Thailand Weather Alert — GitHub Actions edition

Free, serverless 24/7 monitor for all 77 provinces. **No browser or PC needs to stay open, no card required.**

| Part | File | What it does |
|---|---|---|
| Checker | `scripts/check-weather.mjs` | Open-Meteo (temp, feels-like, rain now / next 3-6 h / past 24-72 h) + RainViewer radar echo → classifies every province → posts to Discord when a province **starts or stops** an alert |
| Scheduler | `.github/workflows/weather-alert.yml` | Runs the checker every 15 min, remembers state between runs |
| Dashboard | `index.html` | Leaflet map + RainViewer radar overlay + the 5 summary cards (Normal / Rain / Flood / Heat / Cold) |
| Tests | `scripts/test.mjs` | Offline tests (`node scripts/test.mjs`) — rules, radar PNG decoding, notify/debounce flow |

No `npm install` is needed — the script has zero dependencies (Node 22 on the runner).

## Status rules (priority: flood > heat > rain > cold > ok)

| State | Condition |
|---|---|
| 🌊 Flood risk | rain now ≥ 15 mm/h • next 3 h ≥ 30 mm • next 6 h ≥ 50 mm or any hour ≥ 20 mm • past 24 h ≥ 90 mm (or ≥ 60 with ≥ 20 mm coming) • past 72 h ≥ 150 mm |
| 🔥 Extreme heat | feels-like (Open-Meteo `apparent_temperature`, a heat-index equivalent) ≥ **40 °C** |
| 🌧️ Rain | rain now ≥ 0.5 mm/h • or ≥ 5 mm expected in 3 h • or **radar echo** within ~2 km of the province point (≥ 3 of 25 pixels) |
| ❄️ Cold | air temp ≤ **16 °C** |
| 😊 Normal | none of the above |

Thresholds are in `loadConfig()` (script) and `CFG` (dashboard) — keep them identical. The script also reads them from repo **Variables** (below).

An alert "ends" only after **2 consecutive calm readings** (no flapping). Alert→alert changes (rain→flood) are sent immediately.

---

## Setup (≈10 minutes)

### 1. Create a Discord webhook
1. Discord → your server → channel ⚙️ **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**.
2. Name it, pick the channel, click **Copy Webhook URL** (looks like `https://discord.com/api/webhooks/123…/abc…`).
3. Treat that URL like a password — anyone with it can post to your channel.

### 2. Create the GitHub repo
1. github.com → **New repository** → **make it Public** (see "Free-tier math" below — this matters).
2. Upload this folder's contents so that `.github/workflows/weather-alert.yml`, `scripts/`, `package.json` and `index.html` are in the repo root.

### 3. Add the Discord webhook as a GitHub secret
1. Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Name: `DISCORD_WEBHOOK` — Value: the webhook URL → **Add secret**.
   Never commit the URL into any file; the workflow reads it only from `secrets.DISCORD_WEBHOOK`.

(Optional) Same page → **Variables** tab → add any of: `ALERT_STATUSES` (default `flood,heat,rain`; add `,cold` to get cold alerts), `HEAT_INDEX_C` (40), `COLD_C` (16), `USE_RADAR` (`0` disables radar), `RADAR_MIN_PIXELS` (3).

### 4. Test it
1. Repo → **Actions** tab → enable workflows if GitHub asks.
2. **Weather Alert** → **Run workflow** → tick **Only send a test message to Discord** → Run. A 🧪 message should appear in Discord.
3. Run it again with the box unticked. The first real run posts the current snapshot of every province that is already in an alert; after that you only get changes.

### 5. Host the dashboard (optional, free)
Repo → **Settings** → **Pages** → Source: *Deploy from a branch* → `main` / `/ (root)` → Save. Your dashboard is at `https://<user>.github.io/<repo>/`. The dashboard fetches Open-Meteo and RainViewer directly from the visitor's browser, so it is independent of the Action. You can also just open `index.html` locally.

---

## Free-tier math (important)

* **Public repo: GitHub Actions minutes are free and unlimited.** This is the setup to use.
* **Private repo: 2,000 free min/month, and each run is billed rounded up to a full minute.** A run every 15 min = 96/day ≈ **2,880 min/month → over the limit**, even though the script itself takes ~3-8 s. If you must be private, use `cron: '7,37 * * * *'` (every 30 min ≈ 1,440 min/month).
* Nothing sensitive lives in the repo: the webhook is in Secrets; the state is in the Actions cache.

## Things to know

* **Schedule timing is best-effort.** GitHub may delay scheduled runs by several minutes at busy times (and occasionally skips one). Don't rely on exact 15-min spacing.
* **60-day rule:** GitHub disables scheduled workflows in repos with no activity for 60 days. The last workflow step tries to re-enable itself on every run; if you ever get GitHub's "scheduled workflow disabled" email, just click **Enable workflow** in the Actions tab.
* **State is stored in the Actions cache.** If it's ever evicted, the next run re-announces all currently-active provinces once (harmless, no data loss).
* **Open-Meteo free API** is for non-commercial use, ~10,000 calls/day per IP (each province counts as one call): 77 × 96 runs ≈ 7,400/day. GitHub runners share IPs with other projects, so occasional HTTP 429s are possible; the script retries with back-off, and a failed chunk is just skipped for that run.
* **RainViewer public tiles** currently offer *past* radar frames only (about 2 h, 10-min steps), max zoom 7 (≈1 km/pixel). The checker uses the newest frame and ignores it if older than 40 min. If radar fails, the run continues with Open-Meteo only. Radar may show light echoes that don't reach the ground — raise `RADAR_MIN_PIXELS` or set `USE_RADAR=0` if you see too many radar-only rain alerts.
* **Heat:** Open-Meteo's feels-like is used as the heat index. If 40 °C fires too rarely/often for you, change `HEAT_INDEX_C`.

## Discord embed format

One message can carry up to 10 embeds (one per status; long lists continue in "(ต่อ)" embeds; multiple messages if needed). Example payload:

```json
{
  "username": "Thai Weather Alert",
  "content": "🚨 **Thailand Weather Alert** • 09:48 น.\n❗ เสี่ยงน้ำท่วม: เชียงราย, น่าน",
  "allowed_mentions": { "parse": [] },
  "embeds": [
    {
      "title": "🌊 เสี่ยงน้ำท่วม (Flood Risk) — 2 จังหวัด",
      "color": 16275785,
      "description": "❗ **เชียงราย** — คาดฝน 6 ชม. 58 มม. (สูงสุด 24 มม./ชม.) • ฝนสะสม 24 ชม. 96 มม.\n❗ **น่าน** — ฝนสะสม 72 ชม. 163 มม."
    },
    {
      "title": "🔥 ร้อนจัด (Extreme Heat) — 1 จังหวัด",
      "color": 14380328,
      "description": "**อุดรธานี** — ความรู้สึกร้อน 41.3°C (อุณหภูมิ 36.8°C)"
    },
    {
      "title": "🌧️ ฝนตก (Rain) — 2 จังหวัด",
      "color": 4494328,
      "description": "**ตราด** — ฝน 3.2 มม./ชม. • 📡 เรดาร์ยืนยัน\n**ระนอง** — 📡 เรดาร์พบกลุ่มฝนใกล้จังหวัด"
    },
    {
      "title": "✅ กลับสู่ปกติ — 1 รายการ",
      "color": 4176208,
      "description": "✅ **ขอนแก่น** — ฝนหยุดตกแล้ว",
      "footer": { "text": "Open-Meteo • RainViewer • GitHub Actions" },
      "timestamp": "2026-10-11T02:48:00.000Z"
    }
  ]
}
```

Preview a real payload without posting: `DRY_RUN=1 node scripts/check-weather.mjs` (prints the JSON and does not save state; needs internet).

## Local commands

```bash
node scripts/test.mjs                                   # offline tests
DRY_RUN=1 node scripts/check-weather.mjs                # live data, print instead of posting
DISCORD_WEBHOOK='https://discord.com/api/webhooks/…' node scripts/check-weather.mjs
```

Province coordinates: `scripts/provinces.json` (script) and the `PROVINCES` array inside `index.html` (dashboard).
