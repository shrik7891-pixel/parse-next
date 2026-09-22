importScripts('seed_topics.js');
importScripts('supabaseConfig.js');
// ============================================================
// PulseTube Background Service Worker
// ============================================================

const STORAGE_PREFIX = 'pt_';
const CHANNEL_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const YT_CONFIG_TTL = 60 * 60 * 1000; // Re-fetch YT config every 1 hour
const TODAY_FILTER  = 'EgIIAg=='; // InnerTube: Upload date = Today
const WEEK_FILTER   = 'EgIIAw=='; // InnerTube: Upload date = This week

// ============================================================
// SMART CRAWL CONFIGURATION — edit here to tune behaviour
// ============================================================
const CRAWL_CONFIG = {
  // ── Budget per crawl run ─────────────────────────────────
  maxKeywordsPerRun:   125,  // Max keywords crawled per scheduled run (was 60, increased to fit all groups)
  maxVideosPerKeyword:  50,  // Max videos kept per keyword
  maxVideosPerTopic:   150,  // Max videos kept per topic shelf in the DB
  maxTotalVideosInDB: 10000, // Global DB cap; oldest/lowest-score pruned when exceeded

  // ── Search pass tiers ────────────────────────────────────
  // hot  = top-performing keywords → full 5-pass search
  // warm = medium keywords          → 3-pass search
  // cold = rotated/rare keywords    → 2-pass search (week + default)
  hotKeywordsPerGroup:  2,   // Always crawl this many top kw per group (hot)
  warmKeywordsPerGroup: 2,   // Next N per group on warm rotation

  // ── Priority groups (crawled every single run) ───────────
  // These capture fast-moving news/events that go stale quickly
  alwaysCrawlGroups: ['world_news', 'cricket_sports', 'true_crime', 'ai_future', 'bollywood_cinema'],

  // ── TTL / Pruning ────────────────────────────────────────
  videoTTLDays:       14,   // Remove videos older than this
  lowScoreTTLDays:     3,   // Remove LOW-score videos after just 3 days
  lowScoreThreshold:  20,   // pulse_score below this = low-priority

  // ── Auto-scan defaults ───────────────────────────────────
  defaultIntervalMin: 60,   // Full crawl every 60 minutes
  newsIntervalMin:    30,   // Priority groups every 30 minutes (future)
  keywordCooldownMs:  15 * 60 * 1000, // 15 mins cooldown so new keywords can be tested without redundant recrawls

  // ── Topic-Specific Tuning (Pulse Score Decay & Active Hours) ──
  // Fast decay (news): 24h. Slow decay (docs/evergreen): 72h. Default: 48h.
  decayHalfLife: {
    world_news: 24, tech_gadgets: 24, gaming_esports: 24, crypto_finance: 24,
    history_mythology: 72, deep_docs: 72, mega_engineering: 72, true_crime: 72,
    space_universe: 72, nature_4k: 72, art_creative: 72, diy_making: 72
  },
  
  // Hours when a topic is considered "active" (local extension time). If outside, it drops to cold tier.
  // Format: [startHour, endHour] (0-23). 
  activeHours: {
    gaming_esports: [18, 2],    // Evening / Late Night
    world_news: [6, 12],        // Morning
    business_markets: [8, 16],  // Trading hours
    coding_dev: [10, 18]        // Work hours
  }
};

// ─────────────────────────────────────────────────────────────
// KEYWORD SELECTION: picks up to maxKeywordsPerRun per run
// Ensures every group gets representation; hot groups get priority
// ─────────────────────────────────────────────────────────────
function selectKeywordsForRun(topics, isManual = false, timestamps = {}) {
  const cfg    = CRAWL_CONFIG;
  const result = []; // [{ topicId, keyword, tier }]
  const now    = Date.now();

  // Track which cycle we're on (stored in memory; resets on SW restart)
  if (!selectKeywordsForRun._cycle) selectKeywordsForRun._cycle = 0;
  const cycle = selectKeywordsForRun._cycle++;

  for (const topic of topics) {
    if (!topic.enabled) continue;
    
    // Skip keywords that were just crawled recently (cooldown)
    const kws = (topic.keywords || []).filter(kw => {
      const lastCrawled = timestamps[kw] || 0;
      return (now - lastCrawled) > cfg.keywordCooldownMs;
    });
    
    if (kws.length === 0) continue;

    const isAlways = cfg.alwaysCrawlGroups.includes(topic.id);

    if (isManual) {
      // Force FULL crawl of every keyword without rotation slices
      kws.forEach((kw, index) => {
        const tier = index < cfg.hotKeywordsPerGroup ? 'hot' : 'warm';
        result.push({ topicId: topic.id, keyword: kw, tier: isAlways ? 'hot' : tier });
      });
      continue;
    }

    // Check Active Hours
    const currentHour = new Date().getHours();
    let isTopicActive = true;
    if (cfg.activeHours[topic.id]) {
      const [start, end] = cfg.activeHours[topic.id];
      if (start <= end) {
        isTopicActive = currentHour >= start && currentHour <= end;
      } else { // Wraps around midnight (e.g. 18 to 2)
        isTopicActive = currentHour >= start || currentHour <= end;
      }
    }

    // Slot hot keywords — always crawled if active or isAlways
    const hot = kws.slice(0, cfg.hotKeywordsPerGroup);
    hot.forEach(kw => {
      const tier = (isTopicActive || isAlways) ? 'hot' : 'cold'; // Downgrade if inactive
      result.push({ topicId: topic.id, keyword: kw, tier });
    });

    // Slot warm keywords — rotate through rest of list each cycle
    const remaining = kws.slice(cfg.hotKeywordsPerGroup);
    if (remaining.length > 0) {
      const offset = (cycle * cfg.warmKeywordsPerGroup) % remaining.length;
      const warm   = remaining.slice(offset, offset + cfg.warmKeywordsPerGroup);
      // wrap around if we hit the end
      const extra  = offset + cfg.warmKeywordsPerGroup > remaining.length
        ? remaining.slice(0, (offset + cfg.warmKeywordsPerGroup) % remaining.length)
        : [];
      [...warm, ...extra].forEach(kw => result.push({ topicId: topic.id, keyword: kw, tier: isAlways ? 'hot' : 'warm' }));
    }
  }

  // Cap total to budget — keep hot first, then warm, then cold
  const hot  = result.filter(r => r.tier === 'hot');
  const warm = result.filter(r => r.tier === 'warm');
  const cold = result.filter(r => r.tier === 'cold');
  
  let budget = [];
  if (isManual) {
    // If manual crawl, force FULL crawl of every keyword across all groups
    // Convert all to at least 'warm' to ensure thorough scanning
    budget = result.map(r => ({ ...r, tier: r.tier === 'cold' ? 'warm' : r.tier }));
  } else {
    budget = [...hot, ...warm, ...cold].slice(0, cfg.maxKeywordsPerRun);
  }

  console.log(`[PulseTube] 🎯 Keyword budget: ${budget.length}/${result.length} selected (isManual: ${isManual})`);
  return budget;
}

// Persistent tab reused across all crawl sessions (never closed — SP CHROME pattern)
let _ytConfigCache = null;
let _ytConfigCacheTime = 0;

// Setup Comprehensive Declarative Net Request rules to bypass YouTube embed restrictions (Error 153 & 152)
async function setupDeclarativeRules() {
  if (typeof chrome.declarativeNetRequest === 'undefined') return;
  try {
    const rules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
          ]
        },
        condition: {
          urlFilter: 'https://www.youtube.com/*',
          resourceTypes: ['sub_frame', 'xmlhttprequest', 'script', 'image', 'stylesheet', 'other']
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' }
          ]
        },
        condition: {
          urlFilter: 'https://www.youtube.com/embed/*',
          resourceTypes: ['sub_frame']
        }
      },
      {
        id: 3,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
          ]
        },
        condition: {
          urlFilter: 'https://www.youtube-nocookie.com/*',
          resourceTypes: ['sub_frame', 'xmlhttprequest', 'script', 'image', 'stylesheet', 'other']
        }
      },
      {
        id: 4,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' }
          ]
        },
        condition: {
          urlFilter: 'https://www.youtube-nocookie.com/embed/*',
          resourceTypes: ['sub_frame']
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2, 3, 4],
      addRules: rules
    });
    console.log('[PulseTube] Comprehensive DeclarativeNetRequest rules registered successfully.');
  } catch (err) {
    console.error('[PulseTube] Failed to register DeclarativeNetRequest rules:', err.message);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[PulseTube] Extension installed. Creating alarms...');
  chrome.alarms.create('pulse_crawl_alarm', { periodInMinutes: 1440 });
  
  const minuteRes = await chrome.storage.local.get(`${STORAGE_PREFIX}cloud_sync_minute`);
  const minute = minuteRes[`${STORAGE_PREFIX}cloud_sync_minute`] !== undefined ? minuteRes[`${STORAGE_PREFIX}cloud_sync_minute`] : 15;
  const now = new Date();
  let nextRun = new Date(now);
  nextRun.setMinutes(minute, 0, 0);
  if (nextRun.getTime() <= now.getTime()) {
    nextRun.setHours(nextRun.getHours() + 1);
  }
  chrome.alarms.create('github_cloud_sync_alarm', { when: nextRun.getTime(), periodInMinutes: 60 });
  
  // Register rules after SW is fully initialized to prevent "No SW" error
  await setupDeclarativeRules();
  
  // Clear any stuck crawl state
  await chrome.storage.local.set({
    [`${STORAGE_PREFIX}crawl_progress`]: { running: false, progressPercent: 0 }
  });
  
  // Pre-populate live Supabase project credentials for instant direct testing
  await chrome.storage.local.set({
    [`${STORAGE_PREFIX}supabase_url`]: SUPABASE_CONFIG.url,
    [`${STORAGE_PREFIX}supabase_key`]: SUPABASE_CONFIG.key
  });
  
  // Seed topics if empty
  seedDefaultTopics();
});

async function triggerGitHubAction() {
  const result = await chrome.storage.local.get([`${STORAGE_PREFIX}github_token`, `${STORAGE_PREFIX}github_repo`, `${STORAGE_PREFIX}tv_sync_enabled`]);
  let token = result[`${STORAGE_PREFIX}github_token`];
  const repo = result[`${STORAGE_PREFIX}github_repo`] || 'shrik7891-pixel/pulsetube-next';
  const isSyncEnabled = result[`${STORAGE_PREFIX}tv_sync_enabled`] !== false;
  
  if (!isSyncEnabled) {
    console.log('[PulseTube] Cloud Sync skipped: TV Sync is disabled in Settings.');
    return;
  }

  if (!token) {
    console.warn('[PulseTube] Cannot trigger Cloud Sync: Missing GitHub PAT');
    return;
  }
  
  if (token.startsWith('gho_')) {
    // Handle invalid CLI tokens if somehow bypassed
    console.warn('[PulseTube] Invalid token type, Cloud Sync aborted');
    return;
  }
  
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/crawl-next.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: 'main' })
    });
    
    if (res.ok) {
      console.log('[PulseTube] Cloud Sync triggered via alarm successfully!');
      // Notify any open options page so the terminal pops up instantly
      chrome.runtime.sendMessage({ action: 'cloud_sync_started' }).catch(() => {});
    } else {
      const errText = await res.text();
      console.error(`[PulseTube] Cloud Sync failed with status ${res.status}: ${errText}`);
    }
  } catch (e) {
    console.warn('[PulseTube] Failed to trigger Cloud Sync alarm:', e.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pulse_crawl_alarm') {
    console.log('[PulseTube] Alarm triggered. Starting crawl...');
    runCrawl();
  } else if (alarm.name === 'github_cloud_sync_alarm') {
    console.log('[PulseTube] Alarm triggered. Starting Cloud Sync...');
    triggerGitHubAction();
  }
});

// ============================================================
// SUPABASE SYNC CREDENTIALS (PHASE 2)
// ============================================================
async function getSupabaseCredentials() {
  const result = await chrome.storage.local.get([`${STORAGE_PREFIX}supabase_url`, `${STORAGE_PREFIX}supabase_key`, `${STORAGE_PREFIX}admin_uuid`]);
  let url = result[`${STORAGE_PREFIX}supabase_url`] || SUPABASE_CONFIG.url;
  let key = result[`${STORAGE_PREFIX}supabase_key`] || SUPABASE_CONFIG.key;
  
  // Force override old local server overrides
  if (url.includes('127.0.0.1') || url.includes('localhost') || url.includes('8085')) {
    url = SUPABASE_CONFIG.url;
    await chrome.storage.local.set({ [`${STORAGE_PREFIX}supabase_url`]: url });
  }

  let admin_uuid = result[`${STORAGE_PREFIX}admin_uuid`] || '11111111-1111-4111-8111-111111111111';

  url = url.trim().replace(/\/+$/, '');
  return { url, key, admin_uuid };
}

// ============================================================
// DEFAULT TOPICS SEEDING
// ============================================================
async function seedDefaultTopics(forceMerge = false) {
  const result = await chrome.storage.local.get(`${STORAGE_PREFIX}topics`);
  const existingTopics = result[`${STORAGE_PREFIX}topics`] || [];
  
  if (existingTopics.length === 0 || forceMerge) {
    console.log('[PulseTube] Seeding/merging hardcoded defaults for Phase 2.');

    // Read from trendiq_topics JSON if possible, otherwise seed a base list
    const defaultTopics = SEED_TOPICS;
    
    if (forceMerge && existingTopics.length > 0) {
      // Merge logic: keep all existing groups, add new default groups if they don't exist
      const existingIds = new Set(existingTopics.map(t => t.id));
      const topicsToAdd = defaultTopics.filter(dt => !existingIds.has(dt.id));
      const finalTopics = [...existingTopics, ...topicsToAdd];
      await chrome.storage.local.set({ [`${STORAGE_PREFIX}topics`]: finalTopics });
      console.log(`[PulseTube] Merged default topics. Added ${topicsToAdd.length} new groups.`);
    } else {
      await chrome.storage.local.set({ [`${STORAGE_PREFIX}topics`]: defaultTopics });
      console.log('[PulseTube] Default topics seeded entirely.');
    }
  }
}

// ============================================================
// SUPABASE API UTILITIES (PHASE 2)
// ============================================================
async function fetchSupabaseAPI(tablePath, payload, method = 'POST') {
  // Decoupled: Supabase removed in favor of GitHub CDN
  return null;
}

async function querySupabaseAPI(tablePath) {
  // Decoupled: Supabase removed in favor of GitHub CDN
  return [];
}

// Quick deterministic pseudo-UUID generator for topic IDs to match Postgres UUID format
function generateUUID(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

// Push local topics to Supabase (Phase 2 integration)
async function syncTopicsToSupabase() {
  // Decoupled: Supabase removed in favor of GitHub CDN
  return;
}

// Push computed feeds to Supabase
async function pushFeedToSupabase(feedItems) {
  // Decoupled: Supabase removed in favor of GitHub CDN
  return;
}
// ============================================================
// YOUTUBE SEARCH — HEADLESS API (Zero-Tab Architecture)
// ============================================================

async function getYTConfig() {
  // Return cached config if still fresh (within TTL)
  if (_ytConfigCache && (Date.now() - _ytConfigCacheTime < YT_CONFIG_TTL)) {
    return _ytConfigCache;
  }
  try {
    const res = await fetch('https://www.youtube.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();
    const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
    const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
    
    if (apiKey && clientVersion) {
      _ytConfigCache = { apiKey, clientVersion };
      _ytConfigCacheTime = Date.now();
      return _ytConfigCache;
    }
  } catch (e) {
    console.error("[PulseTube] Failed to fetch YouTube config:", e);
  }
  // Fall back to stale cache if available
  if (_ytConfigCache) return _ytConfigCache;
  return null;
}

/**
 * Primary search: Headless API (Zero-Tab).
 * Accepts an optional filterParam (e.g. TODAY_FILTER = 'EgIIAg==').
 */
// ── Per-crawl search result cache ──────────────────────────────
// This Map lives for the duration of a single runCrawl() invocation.
// It prevents the same query+filter from hitting YouTube twice.
let _searchCache = new Map();
let _consecutive429s = 0; // Circuit breaker counter

function resetSearchCache() {
  _searchCache = new Map();
  _consecutive429s = 0;
}

async function fetchSearch(query, filterParam = null) {
  // Check per-crawl cache first
  const cacheKey = `${query}|${filterParam || 'default'}`;
  if (_searchCache.has(cacheKey)) {
    console.log(`[PulseTube]  ♻️ CACHE HIT "${query}" (${filterParam || 'default'})`);
    return _searchCache.get(cacheKey);
  }

  // Circuit breaker: if 3+ consecutive 429s, pause for 60s before continuing
  if (_consecutive429s >= 3) {
    console.warn(`[PulseTube] ⚠️ Circuit breaker triggered (${_consecutive429s} consecutive 429s). Pausing 60s...`);
    await new Promise(r => setTimeout(r, 60000));
    _consecutive429s = 0;
  }

  const config = await getYTConfig();
  if (config) {
    const body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: config.clientVersion,
          hl: 'en',
          gl: 'US'
        }
      },
      query: query
    };
    
    if (filterParam) body.params = filterParam;

    // Retry with exponential backoff for transient failures
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const resp = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${config.apiKey}&prettyPrint=false`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'X-YouTube-Client-Version': config.clientVersion
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (resp.ok) {
          _consecutive429s = 0; // Reset circuit breaker on success
          const data = await resp.json();
          if (data && data.contents) {
            const results = parseSearchResponse(data);
            _searchCache.set(cacheKey, results); // Cache for this crawl run
            return results;
          }
        } else if (resp.status === 429 || resp.status === 403) {
          _consecutive429s++;
          const backoff = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.warn(`[PulseTube] ⚠️ HTTP ${resp.status} for "${query}" — backoff ${backoff}ms (attempt ${attempt + 1}/3)`);
          await new Promise(r => setTimeout(r, backoff));
          continue; // Retry — do NOT fall through to scrape (it will also be blocked)
        } else {
          console.warn(`[PulseTube] Headless API HTTP ${resp.status} for "${query}"`);
          break; // Non-retryable error, fall through to scrape
        }
      } catch (e) {
        if (attempt < 2) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 5000);
          console.warn(`[PulseTube] Headless API failed for "${query}": ${e.message} — retrying in ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
        } else {
          console.warn(`[PulseTube] Headless API failed for "${query}": ${e.message} (all retries exhausted)`);
        }
      }
    }
  }

  // Fallback: HTML scrape fallback (always works from service worker)
  const scrapeResults = await fetchSearchScrape(query, filterParam);
  _searchCache.set(cacheKey, scrapeResults); // Cache scrape results too
  return scrapeResults;
}

/**
 * Scrapes youtube.com/results page — works from service worker (no Origin restriction).
 * Uses &sp= query param to apply date filters.
 */
async function fetchSearchScrape(query, filterParam = null) {
  try {
    let url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    if (filterParam) url += `&sp=${encodeURIComponent(filterParam)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      credentials: 'omit', // Don't send YouTube cookies — prevents personalized results
      redirect: 'manual',
      headers: {
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[PulseTube] HTML scrape HTTP ${response.status} for "${query}"`);
      return [];
    }

    const html = await response.text();
    let data = null;

    const match = html.match(/var\s+ytInitialData\s*=\s*({.*?});\s*<\/script>/s);
    if (match) {
      data = JSON.parse(match[1]);
    } else {
      const match2 = html.match(/ytInitialData\s*=\s*'({.*?})'/s);
      if (match2) {
        data = JSON.parse(match2[1].replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
      } else {
        const match3 = html.match(/window\["ytInitialData"\]\s*=\s*({.*?});\s*window/s);
        if (match3) {
          data = JSON.parse(match3[1]);
        }
      }
    }

    if (!data) {
      console.warn(`[PulseTube] ytInitialData not found in HTML for "${query}"`);
      return [];
    }

    const results = parseSearchResponse(data);
    console.log(`[PulseTube] Scrape [${filterParam ? 'TODAY' : 'DEFAULT'}] "${query}" → ${results.length} videos`);
    return results;
  } catch (e) {
    console.warn(`[PulseTube] HTML scrape error for "${query}": ${e.message}`);
    return [];
  }
}

function parseSearchResponse(data) {
  const results = [];
  try {
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents || [];

    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        if (item.videoRenderer) {
          const v = item.videoRenderer;
          const viewText = v.viewCountText?.simpleText || v.viewCountText?.runs?.[0]?.text || '';
          const views = parseViewCount(viewText);
          const publishedText = v.publishedTimeText?.simpleText || '';
          const durationText = v.lengthText?.simpleText || '';

          // 1. Strict Quality Filter: No Shorts, No Live Streams, No Premieres
          // Live/Premieres often lack lengthText, or mention "Streamed", or have LIVE badges
          const isLiveOrPremiere = !durationText || 
                                   /streamed|watching/i.test(viewText) || 
                                   /streamed/i.test(publishedText) ||
                                   v.badges?.some(b => b.metadataBadgeRenderer?.label === 'LIVE');
          if (isLiveOrPremiere) continue;

          // 2. Filter out Shorts (duration < 60 seconds)
          const durationParts = durationText.split(':').map(Number);
          let durationSecs = 0;
          if (durationParts.length === 2) {
            durationSecs = durationParts[0] * 60 + durationParts[1];
          } else if (durationParts.length === 3) {
            durationSecs = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
          }
          if (durationSecs < 60) continue;

          const title = v.title?.runs?.[0]?.text || '';
          if (!title || views === 0) continue;

          const overlays = v.thumbnailOverlays || [];
          const isWatched = overlays.some(o => o.thumbnailOverlayResumePlaybackRenderer);
          if (isWatched) continue;

            results.push({
              videoId: v.videoId || '',
              title: v.title?.runs?.[0]?.text || '',
              duration: v.lengthText?.simpleText || '',
              views: views || 0,
              viewText,
              publishedText,
              channelName: v.ownerText?.runs?.[0]?.text || '',
              channelId: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
              thumbnail: v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1]?.url || '',
              channelAvatar: v.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url || ''
            });
        }
      }
    }
  } catch (e) {
    console.warn('[PulseTube] Search parse error:', e.message);
  }
  return results;
}

function parseViewCount(text) {
  if (!text) return 0;
  if (/watching/i.test(text)) return 0;
  if (/no views/i.test(text)) return 0;
  
  // Clean formats like "152,481 views" or "152K views"
  const clean = text.replace(/,/g, '').toLowerCase();
  
  // Try direct match first: e.g. "125000 views"
  const directMatch = clean.match(/^([\d]+)\s*views?/);
  if (directMatch) return parseInt(directMatch[1], 10);

  // Parse shorthand like "1.2M views" or "45K views"
  const shorthandMatch = clean.match(/^([\d.]+)([km]?)\s*views?/);
  if (shorthandMatch) {
    const num = parseFloat(shorthandMatch[1]);
    const multiplier = shorthandMatch[2] === 'm' ? 1000000 : (shorthandMatch[2] === 'k' ? 1000 : 1);
    return Math.round(num * multiplier);
  }
  return 0;
}

// ============================================================
// CHANNEL BASELINE VIEW SCRAPING & CACHING
// ============================================================
async function getChannelAverageViews(channelId) {
  const cacheKey = `${STORAGE_PREFIX}chan_${channelId}`;
  const result = await chrome.storage.local.get(cacheKey);
  
  if (result[cacheKey] && (Date.now() - result[cacheKey].timestamp < CHANNEL_CACHE_TTL)) {
    return result[cacheKey].average;
  }

  // Fetch average views from channel page (HTML scrape is extremely reliable & bypasses tokens)
  let average = 1000; // default baseline
  try {
    const url = `https://www.youtube.com/channel/${channelId}/videos`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const html = await response.text();
      const match = html.match(/var\s+ytInitialData\s*=\s*({.*?});\s*<\/script>/s);
      if (match) {
        const data = JSON.parse(match[1]);
        const videos = [];
        const items = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[1]?.tabRenderer?.content
          ?.richGridRenderer?.contents || [];

        for (const item of items) {
          const v = item.richItemRenderer?.content?.videoRenderer;
          if (v) {
            const viewsText = v.viewCountText?.simpleText || v.viewCountText?.runs?.[0]?.text || '';
            const views = parseViewCount(viewsText);
            if (views > 0) videos.push(views);
          }
        }

        if (videos.length > 0) {
          const sum = videos.reduce((acc, v) => acc + v, 0);
          average = Math.round(sum / videos.length);
        }
      }
    }
  } catch (err) {
    console.warn(`[PulseTube] Failed to fetch channel average views for ${channelId}:`, err.message);
  }

  // Save to cache
  await chrome.storage.local.set({
    [cacheKey]: {
      average,
      timestamp: Date.now()
    }
  });

  return average;
}

// ============================================================
// VELOCITY & METRIC CALCULATION ENGINE
// ============================================================
async function computeVideoMetrics(video, topicId, kw = '') {
  const videoId = video.videoId;
  const currentViews = video.views;

  // 1. View Count History Snapshots (for 30m change)
  const snapKey = `${STORAGE_PREFIX}snap_${videoId}`;
  const snapResult = await chrome.storage.local.get(snapKey);
  let snapshots = snapResult[snapKey] || [];

  // Append current snapshot
  snapshots.push({ views: currentViews, timestamp: Date.now() });

  // Clean old snapshots (older than 48 hours to match cloud crawler)
  const retentionLimit = Date.now() - (48 * 60 * 60 * 1000);
  snapshots = snapshots.filter(s => s.timestamp > retentionLimit);
  await chrome.storage.local.set({ [snapKey]: snapshots });

  // Compute Current VPH (Views Per Hour velocity)
  let current_vph = 0;
  const thirtyMinsAgo = Date.now() - (30 * 60 * 1000);
  // findLast ensures we get the MOST RECENT snapshot that is at least 30 minutes old, 
  // rather than the oldest snapshot from 48 hours ago!
  const targetSnap = snapshots.findLast ? snapshots.findLast(s => s.timestamp <= thirtyMinsAgo) : snapshots.slice().reverse().find(s => s.timestamp <= thirtyMinsAgo);
  if (targetSnap) {
    const hours = (Date.now() - targetSnap.timestamp) / 3600000;
    current_vph = Math.round(Math.max(0, currentViews - targetSnap.views) / hours);
  } else if (snapshots.length > 1) {
    const oldest = snapshots[0];
    const durationHours = (Date.now() - oldest.timestamp) / 3600000;
    if (durationHours > 0.08) { // > 5 minutes
      current_vph = Math.round((currentViews - oldest.views) / durationHours);
    }
  }

  // 2. VPH (Views Per Hour)
  let ageHours = parseAgeTextToHours(video.publishedText);
  let vph = 0;
  if (ageHours && ageHours > 0) {
    vph = Math.round(currentViews / ageHours);
  } else {
    vph = current_vph;
  }

  // 3. Performance Ratio vs channel baseline
  const avgViews = await getChannelAverageViews(video.channelId);
  const performance = avgViews > 0 ? parseFloat((currentViews / avgViews).toFixed(2)) : 1.0;

  // 4. Composite Pulse Score — the primary sort signal
  const pulse_score = computePulseScore(vph, performance, current_vph, video.publishedText, snapshots, topicId);

  // 5. Absolute Unix Timestamp for true numerical sorting across UI and TV
  let published_unix = Date.now();
  if (ageHours) {
    published_unix = Date.now() - Math.round(ageHours * 3600000);
  }

  return {
    id: videoId,
    topic_id: topicId,
    title: video.title,
    channel_title: video.channelName,
    published_time: video.publishedText,
    published_unix: published_unix,
    duration: video.duration,
    thumbnail: video.thumbnail,
    views: currentViews,
    vph,
    current_vph,
    performance,
    pulse_score,
    keyword: kw,
    channel_avatar: video.channelAvatar || ''
  };
}

function parseAgeTextToHours(text) {
  if (!text) return null;
  const clean = text.replace(/^Streamed\s+/i, '').toLowerCase();
  const match = clean.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = {
    second: 1 / 3600,
    minute: 1 / 60,
    hour: 1,
    day: 24,
    week: 168,
    month: 720,
    year: 8760
  };
  return n * (multipliers[unit] || 0);
}

// ============================================================
// PULSE SCORE — composite trending signal
// Higher = more likely to be genuinely breaking out right now
// ============================================================
function computePulseScore(vph, performance, current_vph, publishedText, snapshots = [], topicId = null) {
  // 1. Recency Bonus: Category-Aware Smooth Exponential Decay (Max 100 points)
  const ageHours = parseAgeTextToHours(publishedText) || 720;
  const halfLife = (CRAWL_CONFIG.decayHalfLife && CRAWL_CONFIG.decayHalfLife[topicId]) || 48; // Default 48h
  const recencyBonus = Math.max(0, 100 * Math.exp(-ageHours / halfLife));

  // 2. Log-scale VPH (Max ~150 points for 100k VPH)
  const vphScore = Math.log10(Math.max(1, vph)) * 30;

  // 3. First-Discovery Boost
  // If this is the very first time we've seen this video, give it a small boost 
  // since its current_vph is effectively 0 right now.
  const discoveryBoost = snapshots.length === 1 ? 15 : 0;

  // 3. Performance Ratio with Baseline Confidence Floor (Max 160 points)
  // Calculate what the baseline was based on current views and the performance ratio
  const currentViews = (vph * ageHours) || 1; // Approx current views
  const estimatedBaseline = performance > 0 ? (currentViews / performance) : 0;
  
  let confidenceMultiplier = 1.0;
  if (estimatedBaseline < 500) {
    confidenceMultiplier = 0.2; // Severely dampen noise from micro-channels
  } else if (estimatedBaseline < 2000) {
    confidenceMultiplier = 0.5; // Dampen low-baseline channels
  }
  
  const adjustedPerformance = performance * confidenceMultiplier;
  const perfScore = Math.min(adjustedPerformance, 20) * 8;

  // 4. Acceleration Score (Max ~80 points)
  // We want to know if the CURRENT hourly velocity is outperforming the LIFETIME velocity.
  
  // If current_vph is 0 (brand new discovery), pad it with a quarter of VPH so it doesn't get buried
  const currentHourlyVelocity = current_vph === 0 ? (vph / 4) : current_vph; 
  
  // Acceleration Ratio: Current Velocity / Lifetime Velocity
  // (Adding 1 to denominator prevents Infinity)
  const accelerationRatio = currentHourlyVelocity / (vph + 1);
  
  // Log-scale the acceleration (so a massive 10x acceleration gives 20 points, 100x gives 40)
  const accelerationScore = Math.log10(Math.max(1, accelerationRatio * 10)) * 20;

  return Math.round(vphScore + perfScore + accelerationScore + recencyBonus + discoveryBoost);
}

// ============================================================
// MAIN CRAWL EXECUTION
// ============================================================
async function runCrawl(targetTopicId = null, isManual = false) {
  console.log('[PulseTube] Starting background metric crawl...');
  
  // 1. Fetch Master List from Local Storage
  let topics = [];

  if (topics.length === 0) {
    const result = await chrome.storage.local.get(`${STORAGE_PREFIX}topics`);
    topics = result[`${STORAGE_PREFIX}topics`] || [];
  }
  let enabledTopics = topics.filter(t => t.enabled !== false);

  if (targetTopicId) {
    enabledTopics = enabledTopics.filter(t => t.id === targetTopicId);
  } else if (!isManual) {
    // Distributed Auto-Crawl: Check last_crawled to prevent multiple Macs crawling same group
    const fiftyMinsAgo = Date.now() - (50 * 60 * 1000);
    enabledTopics = enabledTopics.filter(t => !t.last_crawled || t.last_crawled < fiftyMinsAgo);
  }

  if (enabledTopics.length === 0) {
    console.log('[PulseTube] No active or outdated topics configured. Skipping crawl.');
    await chrome.storage.local.set({
      [`${STORAGE_PREFIX}crawl_progress`]: { running: false, progressPercent: 0 }
    });
    return;
  }

  // 3. (REMOVED) Headless API does not require a persistent YouTube tab

  // 4. Calculate progress totals
  const totalKeywords = enabledTopics.reduce((acc, t) => acc + (t.keywords || []).length, 0);
  let processedKeywords = 0;

  const progressState = {
    running: true,
    totalTopics: enabledTopics.length,
    currentTopicIndex: 0,
    currentTopicName: '',
    currentKeyword: '',
    progressPercent: 0,
    timestamp: Date.now()
  };
  await chrome.storage.local.set({ [`${STORAGE_PREFIX}crawl_progress`]: progressState });
  chrome.runtime.sendMessage({ action: 'crawl_progress', status: 'starting', ...progressState }, () => chrome.runtime.lastError);

  const allFeedItems = [];

  // Reset the per-crawl search cache so duplicate keywords across topics get cache hits
  resetSearchCache();

  // Fetch keyword timestamps for cooldown checking
  const tsResult = await chrome.storage.local.get(`${STORAGE_PREFIX}keyword_timestamps`);
  const keywordTimestamps = tsResult[`${STORAGE_PREFIX}keyword_timestamps`] || {};

  // 5. Select keyword budget for this run (tiered rotation or full if manual)
  const budgetedKeywords = selectKeywordsForRun(enabledTopics, isManual, keywordTimestamps);

  // Group budgeted keywords back by topic for progress reporting
  const topicKeywordMap = new Map();
  for (const { topicId, keyword, tier } of budgetedKeywords) {
    if (!topicKeywordMap.has(topicId)) topicKeywordMap.set(topicId, []);
    topicKeywordMap.get(topicId).push({ keyword, tier });
  }

  // 6. Process topics — only those that have keywords in this run's budget
  const activeBudgetTopics = enabledTopics.filter(t => topicKeywordMap.has(t.id));
  for (let ti = 0; ti < activeBudgetTopics.length; ti++) {
    const topic    = activeBudgetTopics[ti];
    const kwSlots  = topicKeywordMap.get(topic.id) || [];
    console.log(`[PulseTube] Processing topic "${topic.name}" (${kwSlots.length} budgeted keywords)...`);

    progressState.currentTopicIndex = ti + 1;
    progressState.currentTopicName  = topic.name;
    progressState.currentKeyword    = kwSlots.map(s => s.keyword).join(', ');
    chrome.runtime.sendMessage({ action: 'crawl_progress', status: 'crawling', ...progressState }, () => chrome.runtime.lastError);

    // Tiered search per keyword — optimized to remove unnecessary all-time searches
    // Process sequentially with delays to prevent YouTube rate-limiting
    const keywordResults = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    
    for (let i = 0; i < kwSlots.length; i++) {
      const { keyword: kw, tier } = kwSlots[i];
      
      // Update UI with progress
      progressState.currentKeyword = `${kw} (${i + 1}/${kwSlots.length})`;
      chrome.runtime.sendMessage({ action: 'crawl_progress', status: 'crawling', ...progressState }, () => chrome.runtime.lastError);
      
      let fetches = [];
      try {
        if (tier === 'hot') {
          // 3-pass: today + week + default (highly relevant & recent)
          const t = await fetchSearch(kw, TODAY_FILTER); await sleep(500);
          const w = await fetchSearch(kw, WEEK_FILTER); await sleep(500);
          const d = await fetchSearch(kw);
          fetches = [...t, ...w, ...d];
          console.log(`[PulseTube]  🔴 HOT  "${kw}" → t:${t.length} w:${w.length} d:${d.length}`);
        } else if (tier === 'warm') {
          // 2-pass: week + default
          const w = await fetchSearch(kw, WEEK_FILTER); await sleep(500);
          const d = await fetchSearch(kw);
          fetches = [...w, ...d];
          console.log(`[PulseTube]  🟡 WARM "${kw}" → w:${w.length} d:${d.length}`);
        } else {
          // 1-pass: week (cold/rotation)
          const w = await fetchSearch(kw, WEEK_FILTER);
          fetches = [...w];
          console.log(`[PulseTube]  🔵 COLD "${kw}" → w:${w.length}`);
        }

        // Deduplicate and cap per CRAWL_CONFIG
        const seen = new Set();
        const merged = [];
        for (const v of fetches) {
          if (v.videoId && !seen.has(v.videoId)) { seen.add(v.videoId); merged.push(v); }
        }
        
        keywordResults.push({ status: 'fulfilled', value: { kw, videos: merged.slice(0, CRAWL_CONFIG.maxVideosPerKeyword) } });
        
        // Save timestamp for cooldown
        keywordTimestamps[kw] = Date.now();
        await chrome.storage.local.set({ [`${STORAGE_PREFIX}keyword_timestamps`]: keywordTimestamps });
        
      } catch (err) {
        console.error(`[PulseTube] Error fetching keyword "${kw}":`, err);
        keywordResults.push({ status: 'rejected', reason: err });
      }
      
      // Delay before next keyword
      if (i < kwSlots.length - 1) {
        await sleep(1500);
      }
    }

    // Compute metrics for all results
    let totalVideosToProcess = 0;
    for (const kwResult of keywordResults) {
      if (kwResult.status === 'fulfilled' && kwResult.value) {
        totalVideosToProcess += kwResult.value.videos.length;
      }
    }

    let processedVideos = 0;

    for (const kwResult of keywordResults) {
      if (kwResult.status !== 'fulfilled' || !kwResult.value) continue;
      const { kw, videos } = kwResult.value;

      // Process videos sequentially with a small delay to prevent channel scrape rate-limits
      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        
        // Calculate individual progress
        const localProgress = processedVideos++;
        progressState.progressPercent = totalVideosToProcess > 0
          ? Math.round((localProgress / totalVideosToProcess) * 100) : 0;
        
        const displayKw = `${kw} (Analyzing video ${Math.min(localProgress + 1, totalVideosToProcess)} of ${totalVideosToProcess})`;
        const tempState = { ...progressState, currentKeyword: displayKw };
        chrome.runtime.sendMessage({ action: 'crawl_progress', status: 'crawling', ...tempState }, () => chrome.runtime.lastError);

        try {
          const computedItem = await computeVideoMetrics(video, topic.id, kw);
          if (computedItem.performance >= 1.0 || computedItem.vph >= 10) {
            allFeedItems.push(computedItem);
          }
        } catch (err) {
          console.error(`[PulseTube] Metric error for ${video.videoId}:`, err.message);
        }
        
        // Small delay to prevent hammering YouTube channel pages
        if (i < videos.length - 1) {
          await sleep(200);
        }
      }
      await chrome.storage.local.set({ [`${STORAGE_PREFIX}crawl_progress`]: progressState });
    }

    // Incremental push to local server after each topic finishes
    await pushIncremental(allFeedItems);

    // Update distributed timestamp with fresh data to avoid overwriting user edits
    const currentStorage = await chrome.storage.local.get(`${STORAGE_PREFIX}topics`);
    let currentTopics = currentStorage[`${STORAGE_PREFIX}topics`] || topics;
    const tIndex = currentTopics.findIndex(t => t.id === topic.id);
    if (tIndex >= 0) {
      currentTopics[tIndex].last_crawled = Date.now();
      await chrome.storage.local.set({ [`${STORAGE_PREFIX}topics`]: currentTopics });
      await syncTopicsToSupabase();
    }
  }

  console.log(`[PulseTube] Crawl complete — ${allFeedItems.length} total items collected before deduplication.`);

  // Final push to ensure everything is saved
  await pushIncremental(allFeedItems);

  // 7. Cleanup & Finish

  await chrome.storage.local.set({
    [`${STORAGE_PREFIX}crawl_progress`]: { running: false, progressPercent: 100 },
    [`${STORAGE_PREFIX}last_crawl_time`]: Date.now()
  });
  console.log('[PulseTube] Crawl finalized. Progress reset.');

  chrome.runtime.sendMessage({
    action: 'crawl_progress', status: 'completed', running: false, progressPercent: 100
  }).catch(() => {});

  console.log('[PulseTube] ✅ Metric crawl completed successfully!');
}

async function pushIncremental(items) {
  const uniqueItemsMap = new Map();
  for (const item of items) {
    if (!uniqueItemsMap.has(item.id)) {
      uniqueItemsMap.set(item.id, item);
    } else {
      // Keep whichever copy has a higher pulse_score (falls back to vph)
      const existing  = uniqueItemsMap.get(item.id);
      const scoreNew  = (item.pulse_score || 0) || (item.vph || 0);
      const scoreOld  = (existing.pulse_score || 0) || (existing.vph || 0);
      if (scoreNew > scoreOld) {
        uniqueItemsMap.set(item.id, item);
      }
    }
  }
  const deduplicatedItems = Array.from(uniqueItemsMap.values());
  if (deduplicatedItems.length > 0) {
    // Save to local storage for Private Mode viewing
    const localRes = await chrome.storage.local.get(`${STORAGE_PREFIX}videos`);
    const localVideos = localRes[`${STORAGE_PREFIX}videos`] || [];
    const localMap = new Map(localVideos.map(v => [v.id, v]));
    
    deduplicatedItems.forEach(item => {
      localMap.set(item.id, {
        id: item.id,
        topic_id: item.topic_id || item.groupId || 'default',
        title: item.title || 'Unknown Title',
        thumbnail: item.thumbnail || '',
        views: item.views || 0,
        vph: item.vph || 0,
        performance: item.performance || item.pulse_score || 1.0,
        current_vph: item.current_vph || 0,
        channel_title: item.channel_title || item.channel || '',
        published_time: item.publishedTime || item.published_time || '',
        duration: item.duration || '',
        created_at: new Date().toISOString()
      });
    });
    
    await chrome.storage.local.set({ [`${STORAGE_PREFIX}videos`]: Array.from(localMap.values()) });

    await pushFeedToSupabase(deduplicatedItems);
  }
  console.log(`[PulseTube] ✅ pushIncremental: ${deduplicatedItems.length} unique videos synced.`);
}

// Message handler for manual trigger or settings sync
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'update_cloud_sync_minute') {
    const minute = message.minute;
    const now = new Date();
    let nextRun = new Date(now);
    nextRun.setMinutes(minute, 0, 0);
    
    if (nextRun.getTime() <= now.getTime()) {
      nextRun.setHours(nextRun.getHours() + 1);
    }
    
    chrome.alarms.create('github_cloud_sync_alarm', {
      when: nextRun.getTime(),
      periodInMinutes: 60
    });
    
    console.log(`[PulseTube] Cloud Sync alarm rescheduled to minute ${minute} (${nextRun.toLocaleTimeString()})`);
    sendResponse({ success: true });
    return true;
  }
  if (message.action === 'run_manual_crawl') {
    runCrawl(message.topicId, true)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }
  if (message.action === 'restore_defaults') {
    chrome.storage.local.remove(`${STORAGE_PREFIX}topics`, async () => {
      const syncPref = await chrome.storage.local.get(`${STORAGE_PREFIX}tv_sync_enabled`);
      const isPrivate = syncPref[`${STORAGE_PREFIX}tv_sync_enabled`] === false;
      
      if (!isPrivate) {
         await seedDefaultTopics(false); // don't force merge, just seed because it's empty
         // Wipe only CUSTOM shelves from Supabase so old ones don't linger, preserving videos of default shelves
         const defaultIds = typeof SEED_TOPICS !== 'undefined' ? SEED_TOPICS.map(t => t.id).join(',') : '';
         if (defaultIds) {
           await fetchSupabaseAPI(`topics?id=not.in.(${defaultIds})`, null, 'DELETE').catch(() => {});
         } else {
           await fetchSupabaseAPI('topics?id=not.eq.fake_id', null, 'DELETE').catch(() => {});
         }
         await syncTopicsToSupabase();
      }
      
      sendResponse({ success: true });
    });
    return true;
  }
  if (message.action === 'sync_topics') {
    syncTopicsToSupabase()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'delete_topic') {
    fetchSupabaseAPI(`topics?id=eq.${message.id}`, null, 'DELETE')
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === 'fetch_videos') {
    chrome.storage.local.get(`${STORAGE_PREFIX}tv_sync_enabled`, (syncPref) => {
      if (syncPref[`${STORAGE_PREFIX}tv_sync_enabled`] === false) {
        chrome.storage.local.get(`${STORAGE_PREFIX}videos`, (res) => {
          sendResponse({ success: true, videos: res[`${STORAGE_PREFIX}videos`] || [] });
        });
      } else {
        (async () => {
          try {
            let allVideos = [];
            // First fetch active topics
            const topicsReq = await querySupabaseAPI(`topics?select=id`);
            if (topicsReq && topicsReq.length > 0) {
               // Fetch top 150 videos per topic independently so no shelf gets starved
               const promises = topicsReq.map(t => querySupabaseAPI(`videos_feed?select=*&topic_id=eq.${t.id}&order=performance.desc,vph.desc&limit=150`));
               const results = await Promise.all(promises);
               results.forEach(res => {
                  if (res && res.length) allVideos = allVideos.concat(res);
               });
            } else {
               const vids = await querySupabaseAPI(`videos_feed?select=*&order=performance.desc,vph.desc&limit=2000`);
               allVideos = vids || [];
            }
            
            // Cache the videos locally for instant loading
            chrome.storage.local.set({ [`${STORAGE_PREFIX}videos`]: allVideos });
            sendResponse({ success: true, videos: allVideos });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();
      }
    });
    return true;
  }
  if (message.action === 'fetch_topics') {
    chrome.storage.local.get(`${STORAGE_PREFIX}tv_sync_enabled`, (syncPref) => {
      if (syncPref[`${STORAGE_PREFIX}tv_sync_enabled`] === false) {
        chrome.storage.local.get(`${STORAGE_PREFIX}topics`, (res) => {
          sendResponse({ success: true, topics: res[`${STORAGE_PREFIX}topics`] || [] });
        });
      } else {
        querySupabaseAPI('topics?select=*')
          .then(data => sendResponse({ success: true, topics: data }))
          .catch(err => sendResponse({ success: false, error: err.message }));
      }
    });
    return true;
  }
  if (message.action === 'ping') {
    querySupabaseAPI('topics?select=id&limit=1')
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// One-Click Launch: Open the main dashboard when the extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
