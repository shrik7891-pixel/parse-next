// ============================================================
// PulseTube TV – Premium Leanback Feature (v3.0)
// ============================================================
//
// ARCHITECTURE:
//  - On launch → "PULSE" combined shelf (all videos, sorted by Viral Score)
//  - Then → one shelf per active keyword group (capitalized, user's name)
//  - Sort modal → change ranking live (Viral Score, Velocity, Growth, Performance)
//  - Browse Groups modal → jump to a single group's full video list
//  - All deduplication is cross-shelf to keep TV feed fresh
//
// ============================================================

import { ShelfRenderer } from '../ui/ytUI.js';
import { showModal, overlayPanelItemListRenderer, buttonItem } from '../ui/ytUI.js';
import resolveCommand from '../resolveCommand.js';
import { configRead, configWrite } from '../config.js';

// ── Envelope Template ─────────────────────────────────────────────────────────
const PULSE_ENVELOPE = {
  "responseContext": {
    "serviceTrackingParams": [{"service":"GFEEDBACK","params":[
      {"key":"browse_id","value":"FEtopics"},
      {"key":"browse_id_prefix","value":""},
      {"key":"logged_in","value":"0"}
    ]}],
    "maxAgeSeconds": 0,
    "responseId": "PulseTube-v3-response"
  },
  "contents": {
    "tvBrowseRenderer": {
      "content": {
        "tvSurfaceContentRenderer": {
          "content": {
            "sectionListRenderer": {
              "contents": [],
              "trackingParams": "CAIQui8i"
            }
          },
          "trackingParams": "CAEQ0IwD",
          "targetId": "browse-feedFEtopics"
        }
      },
      "trackingParams": "CAAQhGc"
    }
  },
  "frameworkUpdates": {
    "entityBatchUpdate": {
      "mutations": [],
      "timestamp": {"seconds":"1779408127","nanos":0}
    }
  }
};

// ── Sort State ────────────────────────────────────────────────────────────────
// 'viral'      = composite score: 0.4*norm(vph) + 0.3*norm(performance) + 0.2*norm(current_vph) + 0.1*norm(views)
// 'vph'        = views per hour (raw velocity)
// 'performance'= ratio vs channel average
// 'current_vph' = current views per hour
// 'views'      = absolute views
function getCurrentSort() {
  return configRead('pulseSort') || 'current_vph';
}

const SORT_LABELS = {
  viral:            '🌟 Pulse Score',
  vph:              '⚡ Top Velocity (VPH)',
  performance:      '🔥 Performance Ratio',
  current_vph:      '📈 Current VPH',
  views:            '👁️ Most Views',
  published_unix:   '📅 Newest First',
  duration_sec:     '⏱️ Duration'
};

// ── Exposed setters ───────────────────────────────────────────────────────────
window.setPulseFeedsSort = function (newSort) {
  if (SORT_LABELS[newSort]) {
    configWrite('pulseSort', newSort);
    console.log('[PulseTube TV] Sort changed to:', newSort);
    resolveCommand({ signalAction: { signal: "RELOAD_PAGE" } });
  }
};

window.addEventListener('hashchange', () => {
  const hash = window.location.hash || '';
  const match = hash.match(/sort=([a-z0-9_]+)/);
  if (match) {
    configWrite('pulseSort', match[1]);
    console.log('[PulseTube TV] Sort updated via hash:', match[1]);
  }
});

// ── Watched Video Tracking ────────────────────────────────────────────────────
// Persists watched video IDs in localStorage so they are excluded from feeds
// after being played. Auto-expires after 7 days so fresh content rotates back.

const WATCHED_KEY = 'PULSE_WATCHED_V1';
const WATCHED_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _watchedCache = null;

function loadWatched() {
  if (_watchedCache) return _watchedCache;
  try {
    const raw = localStorage.getItem(WATCHED_KEY);
    if (!raw) {
      _watchedCache = {};
      return _watchedCache;
    }
    const data = JSON.parse(raw);
    const now = Date.now();
    let changed = false;
    Object.keys(data).forEach(id => {
      if (now - data[id] > WATCHED_TTL_MS) { delete data[id]; changed = true; }
    });
    if (changed) localStorage.setItem(WATCHED_KEY, JSON.stringify(data));
    _watchedCache = data;
    return data;
  } catch(e) { 
    _watchedCache = {};
    return _watchedCache; 
  }
}

function markWatched(videoId) {
  if (!videoId) return;
  try {
    const data = loadWatched();
    if (data[videoId]) return; // Already watched, prevent disk write spam!
    data[videoId] = Date.now();
    localStorage.setItem(WATCHED_KEY, JSON.stringify(data));
    console.log('[PulseTube TV] Marked watched:', videoId);
  } catch(e) {}
}
window.pulseMarkWatched = markWatched;

// Expose for debugging — call from the TV browser console
window.pulseClearWatched = function() {
  localStorage.removeItem(WATCHED_KEY);
  _watchedCache = null;
  console.log('[PulseTube TV] Cleared watched history.');
  resolveCommand({ signalAction: { signal: 'RELOAD_PAGE' } });
};

// ── XHR Interceptor ──────────────────────────────────────────────────────────
const origAddEventListener = XMLHttpRequest.prototype.addEventListener;
XMLHttpRequest.prototype.addEventListener = function (type, listener, options) {
  if (!this._customListeners) this._customListeners = {};
  if (!this._customListeners[type]) this._customListeners[type] = [];
  this._customListeners[type].push(listener);
  return origAddEventListener.apply(this, arguments);
};

const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (body) {
  const self = this;

  let isPulseFeeds = false;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      const bid = parsed?.browseEndpoint?.browseId || parsed?.browseId;
      if (bid && bid.startsWith('FE_pulse_feeds')) {
        isPulseFeeds = true;
      } else if (bid === 'FEtopics' && window.__PULSE_NAV__) {
        isPulseFeeds = true;
        window.__PULSE_NAV__ = false;
      }
      // Detect when user navigates to a video — record it as watched immediately
      const vid = parsed?.watchEndpoint?.videoId
               || parsed?.playerRequest?.videoId
               || parsed?.videoId;
      if (vid) window.pulseMarkWatched(vid);
    } catch(e) {}
  }

  if (isPulseFeeds) {
    console.log('[PulseTube TV] XHR intercepted — building Pulse page...');
    const savedOnReadyStateChange = self.onreadystatechange;
    const savedOnLoad = self.onload;

    buildPulseFeedsPage(JSON.parse(body)).then(pageResponse => {
      const responseTextVal = JSON.stringify(pageResponse);
      const parsedResponseObj = pageResponse;

      const defineProps = (rs) => {
        Object.defineProperties(self, {
          status:            { get: () => 200,               configurable: true },
          statusText:        { get: () => 'OK',              configurable: true },
          readyState:        { get: () => rs,                configurable: true },
          responseText:      { get: () => responseTextVal,   configurable: true },
          response:          { get: () => parsedResponseObj, configurable: true },
          responseURL:       { get: () => '',                configurable: true },
          getResponseHeader: { value: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null, configurable: true, writable: true }
        });
      };

      const fire = (rs, eventType) => {
        defineProps(rs);
        const ev = new Event(eventType || 'readystatechange');
        if (self.onreadystatechange) try { self.onreadystatechange(ev); } catch(e) {}
        if (savedOnReadyStateChange && savedOnReadyStateChange !== self.onreadystatechange) {
          try { savedOnReadyStateChange.call(self, ev); } catch(e) {}
        }
        (self._customListeners?.[eventType || 'readystatechange'] || []).forEach(cb => {
          try { cb.call(self, ev); } catch(e) {}
        });
        try { self.dispatchEvent(ev); } catch(e) {}
      };

      fire(1); fire(2); fire(3); fire(4);
      defineProps(4);
      const loadEv = new Event('load');
      if (self.onload) try { self.onload(loadEv); } catch(e) {}
      if (savedOnLoad && savedOnLoad !== self.onload) try { savedOnLoad.call(self, loadEv); } catch(e) {}
      (self._customListeners?.load || []).forEach(cb => { try { cb.call(self, loadEv); } catch(e) {} });
      try { self.dispatchEvent(loadEv); } catch(e) {}

    }).catch(err => {
      console.error('[PulseTube TV] Build error:', err);
      const warn = makeWarningBrowseResponse("Error: " + err.message);
      const txt = JSON.stringify(warn);
      Object.defineProperties(self, {
        status:            { get: () => 200,      configurable: true },
        statusText:        { get: () => 'OK',     configurable: true },
        readyState:        { get: () => 4,        configurable: true },
        responseText:      { get: () => txt,      configurable: true },
        response:          { get: () => warn,     configurable: true },
        getResponseHeader: { value: (h) => h.toLowerCase() === 'content-type' ? 'application/json' : null, configurable: true }
      });
      if (self.onreadystatechange) self.onreadystatechange();
      if (self.onload) self.onload();
    });

    return; // Do NOT call origSend
  }
  return origSend.apply(this, arguments);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatNumber(num) {
  if (num == null) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'K';
  return String(num);
}

// Capitalize words in a topic name for good-looking TV display
function toTitleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function sortVideos(videos) {
  let cSort = getCurrentSort();
  if (cSort === 'undefined' || !cSort) cSort = 'current_vph';
  
  const sorted = [...videos].sort((a, b) => {
    // 1. Handle Duration
    if (cSort === 'duration_sec') {
      const parseDur = (d) => {
        if (!d) return 0;
        const parts = d.split(':').map(Number);
        if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
        if (parts.length === 2) return parts[0]*60 + parts[1];
        return parts[0] || 0;
      };
      return parseDur(b.duration) - parseDur(a.duration);
    }
    
    // 2. Handle Newest First
    if (cSort === 'published_unix') {
      const getAge = (d) => {
        if (!d) return 999999;
        const text = d.toLowerCase();
        const num = parseInt(text) || 0;
        if (text.includes('minute')) return num / 60;
        if (text.includes('hour')) return num;
        if (text.includes('day')) return num * 24;
        if (text.includes('week')) return num * 168;
        if (text.includes('month')) return num * 730;
        if (text.includes('year')) return num * 8760;
        return 999999;
      };
      return getAge(a.published_time) - getAge(b.published_time);
    }

    // 3. Handle standard numeric sorts
    const targetCol = cSort === 'viral' ? 'performance' : cSort;
    const valA = parseFloat(a[targetCol]) || 0;
    const valB = parseFloat(b[targetCol]) || 0;
    
    // Explicit fallback matching Chrome Extension: rank by performance if tied
    if (valA === valB && targetCol !== 'performance') {
      return (parseFloat(b.performance) || 0) - (parseFloat(a.performance) || 0);
    }
    
    return valB - valA;
  });

  if (videos.length > 1000) {
    console.log(`[PulseTube TV DBG] cSort=${cSort} target=${cSort === 'viral' ? 'performance' : cSort}`);
    console.log(`[PulseTube TV DBG] Top 3 videos:`, sorted.slice(0, 3).map(v => `${v.id}: cvph=${v.current_vph} perf=${v.performance}`));
  }
  return sorted;
}

// Build a single tileRenderer for a video card
function makeVideoTile(video) {
  let cSort = getCurrentSort();
  if (cSort === 'undefined' || !cSort) cSort = 'current_vph';
  
  let metricText = '';
  if (cSort === 'vph') {
    const vphVal = video.vph > 0 ? (video.vph < 1 ? '<1' : formatNumber(video.vph)) : '0';
    metricText = `  •  ${vphVal} VPH`;
  }
  else if (cSort === 'current_vph') {
    const cvph = video.current_vph || video.change_30m || 0;
    const vphVal = cvph > 0 ? (cvph < 1 ? '<1' : formatNumber(cvph)) : '0';
    metricText = `  •  ${vphVal} VPH`;
  }
  else if (cSort === 'performance') metricText = `  •  ${formatNumber(video.performance)} Pulse`;
  
  const subtitleText = `${video.channel_title || 'Channel'}  •  ${formatNumber(video.views)} views  •  ${video.published_time || 'Recently'}${metricText}`;

  return {
    tileRenderer: {
      contentId: video.id,
      contentType: "TILE_CONTENT_TYPE_VIDEO",
      header: {
        tileHeaderRenderer: {
          thumbnail: { thumbnails: [{ url: video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` }] },
          thumbnailOverlays: video.duration ? [{
            thumbnailOverlayTimeStatusRenderer: {
              text: { runs: [{ text: video.duration }] },
              style: "DEFAULT"
            }
          }] : []
        }
      },
      metadata: {
        tileMetadataRenderer: {
          title: {
            simpleText: video.title,
            runs: [{ text: video.title }]
          },
          lines: [{
            lineRenderer: {
              items: [{
                lineItemRenderer: {
                  text: { runs: [{ text: subtitleText }] }
                }
              }]
            }
          }]
        }
      },
      onSelectCommand: { watchEndpoint: { videoId: video.id } },
      style: "TILE_STYLE_YTLR_DEFAULT"
    }
  };
}

// Warning shelf for setup errors
function makeWarningBrowseResponse(message) {
  const envelope = JSON.parse(JSON.stringify(PULSE_ENVELOPE));
  envelope.contents.tvBrowseRenderer.content
    .tvSurfaceContentRenderer.content
    .sectionListRenderer.contents = [
      ShelfRenderer('Setup Required', [{
        tileRenderer: {
          contentId: 'setup-tile',
          contentType: 'TILE_CONTENT_TYPE_VIDEO',
          header: {
            tileHeaderRenderer: {
              thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }] }
            }
          },
          metadata: {
            tileMetadataRenderer: {
              title: { simpleText: message, runs: [{ text: message }] },
              lines: [{
                lineRenderer: {
                  items: [{
                    lineItemRenderer: {
                      text: { runs: [{ text: 'Ensure server.py is running & database is seeded via the Chrome Extension.' }] }
                    }
                  }]
                }
              }]
            }
          },
          onSelectCommand: { watchEndpoint: { videoId: 'dQw4w9WgXcQ' } },
          style: 'TILE_STYLE_YTLR_DEFAULT'
        }
      }])
    ];
  return envelope;
}

// ── Core Page Builder ─────────────────────────────────────────────────────────
async function buildPulseFeedsPage(requestBody) {
  const cSort = getCurrentSort();
  console.log('[PulseTube TV] Building page... sort=' + cSort);

  try {
    // Fetch from next-gen GitHub jsDelivr with fallback to production ptv
    const feedUrls = [
      `https://cdn.jsdelivr.net/gh/shrik7891-pixel/pulsetube-next@prod/tv_feed_latest.json?t=${Date.now()}`,
      `https://cdn.jsdelivr.net/gh/shrik7891-pixel/ptv@prod/tv_feed_latest.json?t=${Date.now()}`
    ];
    const topicsUrls = [
      `https://cdn.jsdelivr.net/gh/shrik7891-pixel/pulsetube-next@prod/topics_latest.json?t=${Date.now()}`,
      `https://cdn.jsdelivr.net/gh/shrik7891-pixel/ptv@prod/topics_latest.json?t=${Date.now()}`
    ];

    let feedRes = await fetch(feedUrls[0]).catch(() => null);
    if (!feedRes || !feedRes.ok) feedRes = await fetch(feedUrls[1]).catch(() => null);

    let topicsRes = await fetch(topicsUrls[0]).catch(() => null);
    if (!topicsRes || !topicsRes.ok) topicsRes = await fetch(topicsUrls[1]).catch(() => null);

    if (feedRes && feedRes.ok) {
      const feedObj = await feedRes.json();
      const flatVideos = [];
      for (const tId in feedObj) {
        for (const v of feedObj[tId]) {
          // Unwrap compressed array format to save 10x memory
          flatVideos.push({
            topic_id: tId,
            id: v[0],
            title: v[1],
            channel_title: v[2],
            views: v[3],
            published_time: v[4],
            duration: v[5],
            vph: v[6],
            performance: v[7],
            growth: v[8],
            current_vph: v[9]
          });
        }
      }
      window.__PULSE_VIDEOS__ = flatVideos;
    }
    
    if (topicsRes.ok) {
      const newTopics = await topicsRes.json();
      if (JSON.stringify(window.__PULSE_TOPICS__) !== JSON.stringify(newTopics)) {
        window.__PULSE_TOPICS__ = newTopics;
        window.dispatchEvent(new Event('pulse_topics_loaded'));
      }
    }
    
    console.log('[PulseTube TV] Fetched fresh tv_feed and topics from GitHub.');
  } catch (e) {
    console.warn('[PulseTube TV] GitHub fetch failed, using cached data.', e);
  }

  const topics = window.__PULSE_TOPICS__ || [];
  const videos = window.__PULSE_VIDEOS__ || [];
  
  // Normalize Supabase videoId to id for compatibility
  for (const v of videos) {
    if (!v.id) v.id = v.videoId;
  }

  if (topics.length === 0 || videos.length === 0) {
    console.warn('[PulseTube TV] No data injected. Is server.py running?');
    return makeWarningBrowseResponse(
      videos.length === 0
        ? 'No videos indexed. Run Manual Crawl in the Chrome Extension.'
        : 'No topics configured. Add keyword groups in the Chrome Extension.'
    );
  }

  const activeTopics = topics.filter(t => t.enabled !== false).sort((a, b) => (a.position || 0) - (b.position || 0));
  const watchedIds   = loadWatched();
  // Filter out watched videos — they will not appear in any shelf
  const freshVideos  = sortVideos(videos).filter(v => !watchedIds[v.id]);
  const globalSeen   = new Set();
  const shelves      = [];

  console.log(`[PulseTube TV] ${Object.keys(watchedIds).length} watched videos filtered out. ${freshVideos.length} fresh videos available.`);


  const requestedBrowseId = requestBody?.browseEndpoint?.browseId || requestBody?.browseId || 'FE_pulse_feeds';
  let targetTopicId = null;
  if (requestedBrowseId.startsWith('FE_pulse_feeds_')) {
    targetTopicId = requestedBrowseId.replace('FE_pulse_feeds_', '');
  }

  if (targetTopicId) {
    // ── SPECIFIC TOPIC TAB ──
    const topic = activeTopics.find(t => t.id === targetTopicId);
    if (!topic) return makeWarningBrowseResponse('Topic not found');
    
    const topicVideos = freshVideos.filter(v => v.topic_id === topic.id);
    const unique = [];
    const seen = new Set();
    for (const v of topicVideos) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        unique.push(v);
      }
    }
    
    if (unique.length === 0) {
      shelves.push(ShelfRenderer(toTitleCase(topic.name), [
        makeVideoTile({
          id: 'dQw4w9WgXcQ',
          title: 'No videos found in this group.',
          channel_title: 'PulseTube System',
          views: 0,
          published_time: 'Just now',
          duration: '0:00',
          thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
        })
      ]));
    } else {
      const cSort = getCurrentSort();
      const sortLabel = SORT_LABELS[cSort] || cSort;
      const shelfTitle = `${toTitleCase(topic.name)}  |  Sorted by: ${sortLabel}`;
      // Chunk into rows of 3 for a vertically long grid view (capped to 15 rows / 45 videos for smooth TV FPS)
      const visibleVideos = unique.slice(0, 45);
      for (let i = 0; i < visibleVideos.length; i += 3) {
        const chunk = visibleVideos.slice(i, i + 3);
        const title = i === 0 ? shelfTitle : ''; // Only title the first row
        shelves.push(ShelfRenderer(title, chunk.map(makeVideoTile)));
      }
    }
  } else {
    // ── MAIN PULSE TAB (ALL TOPICS) ──
    const PULSE_SHELF_SIZE = 45; // 15 rows of 3 videos: silky smooth remote scrolling with zero DOM lag
    
    // Globally sort freshVideos directly to match Chrome Extension exact behavior
    // freshVideos contains all videos from all topics, deduplicated by id
    const pulseTiles = freshVideos.slice(0, PULSE_SHELF_SIZE).map(makeVideoTile);

    if (pulseTiles.length > 0) {
      let cSort = getCurrentSort();
      if (cSort === 'undefined' || !cSort) cSort = 'current_vph';
      
      const sortLabel = SORT_LABELS[cSort] || cSort;
      const shelfTitle = `PULSE All  |  Sorted by: ${sortLabel}`;
      
      // Chunk into rows of 3 for a vertically long grid view
      for (let i = 0; i < pulseTiles.length; i += 3) {
        const chunk = pulseTiles.slice(i, i + 3);
        const title = i === 0 ? shelfTitle : '';
        shelves.push(ShelfRenderer(title, chunk));
      }
    }

  }

  if (shelves.length === 0) { 
    return makeWarningBrowseResponse(
      'Feed table is empty. Trigger Manual Crawl in the Chrome Extension on your Mac.'
    );
  }

  // ── Assemble envelope ──
  const envelope = JSON.parse(JSON.stringify(PULSE_ENVELOPE));

  if (envelope.responseContext?.serviceTrackingParams) {
    envelope.responseContext.serviceTrackingParams.forEach(param => {
      (param.params || []).forEach(p => {
        if (p.key === 'browse_id') p.value = requestedBrowseId;
      });
    });
  }
  if (envelope.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer) {
    envelope.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.targetId = `browse-feed${requestedBrowseId}`;
  }

  // Assign the shelves directly to the sectionListRenderer without extra layout wrappers!
  // This natively fixes all D-Pad double scrolling and focus tracking issues in Leanback.
  envelope.contents.tvBrowseRenderer.content
    .tvSurfaceContentRenderer.content
    .sectionListRenderer.contents = shelves;

  console.log(`[PulseTube TV] Page built: ${shelves.length} shelves, ${videos.length} total videos in DB.`);
  return envelope;
}

// ── Sort Selector Modal ───────────────────────────────────────────────────────
// Hooked via resolveCommand.js using customAction 'PULSE_SORT_SHOW'
window.showPulseSortMenu = function () {
  const cSort = getCurrentSort();
  const sortOptions = Object.entries(SORT_LABELS).map(([key, label]) => {
    return buttonItem(
      { title: label, subtitle: key === cSort ? 'Currently Active' : '' },
      { icon: key === cSort ? 'CHECK' : 'SORT' },
      [{ commandMetadata: { webCommandMetadata: { sendPost: false } },
         commandExecutorCommand: { commands: [{
           customAction: {
             action: 'TT_SET_SORT',
             parameters: key
           }
         }] }
      }]
    );
  });

  showModal(
    { title: 'Sort Pulse Feed', subtitle: `Current: ${SORT_LABELS[getCurrentSort()] || getCurrentSort()}` },
    overlayPanelItemListRenderer(sortOptions),
    'pulse-sort-modal'
  );
};

// ── App Startup Eager Fetch ───────────────────────────────────────────────────
(async function initPulseData() {
  try {
    // We fetch from jsDelivr because it is whitelisted by CSP
    const topicsRes = await fetch(`https://cdn.jsdelivr.net/gh/shrik7891-pixel/ptv@prod/topics_latest.json?t=${Date.now()}`);
    if (topicsRes.ok) {
      window.__PULSE_TOPICS__ = await topicsRes.json();
      console.log('[PulseTube TV] Bootup: Fetched fresh topics from Surge.');
      window.dispatchEvent(new Event('pulse_topics_loaded'));
    } else {
      console.warn('[PulseTube TV] Bootup topics fetch failed: HTTP ' + topicsRes.status);
    }
  } catch (e) {
    console.warn('[PulseTube TV] Bootup topics fetch failed due to CSP or network.', e);
  }
})();
