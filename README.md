# PulseTube Next (v3.0)

Next-Generation YouTube Discovery Engine, Headless Cloud Crawler, Android TV Leanback Mod & Mobile Companion.

---

## 🏗️ Architecture

1. **`crawler/`**:
   - Headless cloud crawler running on automated GitHub Actions (`.github/workflows/crawl-next.yml`).
   - Powered by **`YouTube.js`** for resilient InnerTube extraction and BotGuard/PoToken handling.
   - Dual output: analytical historical snapshots (`pulse_data.json`) and lightweight per-shelf chunked feeds (`shelves/[topic_id].json` at ~5–15 KB each).
   - Automated Brotli (`.br`) pre-compression for ultra-fast CDN streaming.

2. **`tv-mod/`**:
   - Modernized YouTube TV (Cobalt / TizenTube) userScript.
   - Dynamic sidebar tab injection with fast per-shelf loading.
   - Virtualized 15-row display (45 video tiles) for smooth remote navigation with zero DOM stutter.

3. **`extension/`**:
   - PulseTube Chrome Extension command center.
   - Topic shelf management, drag-and-drop keyword grouping, inline SVG sparklines, and momentum tracking.
   - Native integration with `shrik7891-pixel/pulsetube-next`.

---

## 🚀 Deployment & Branch Structure

- **`main`**: Complete source code, workflows, configurations, and topic definitions.
- **`live-data`**: Analytical master telemetry (`pulse_data.json` + Brotli) containing 48 historical snapshots.
- **`prod`**: Production TV & mobile feeds (`tv_feed_latest.json`, `shelves/`, `shelves_index.json`, `topics_latest.json`).
