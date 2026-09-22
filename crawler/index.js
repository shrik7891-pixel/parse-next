// ============================================================
// Telemetry Dataset Ingestion Engine (Node.js)
// Powered by YouTube.js (InnerTube Client) + Brotli Edge Encoding
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let Innertube;
try {
  Innertube = require('youtubei.js').Innertube;
} catch (e) {
  // If youtubei.js is not yet installed in local development
}

const CRAWL_CONFIG = {
  maxVideosPerKeyword: 50,
  decayHalfLife: { default: 48 },
  historySnapshotsLimit: 48 // 24 hours of 30-min snapshots
};

function parseAgeTextToHours(text) {
  if (!text) return null;
  const match = text.replace(/^Streamed\s+/i, '').match(/(\d+)\s*(second|minute|hour|day|week|month|year)/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const m = { second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720, year: 8760 };
  return n * (m[match[2].toLowerCase()] || 0);
}

function computePulseScore(vph, publishedText, topicId) {
  const ageHours = parseAgeTextToHours(publishedText) || 720;
  const recencyBonus = Math.max(0, 100 * Math.exp(-ageHours / 48));
  const vphScore = Math.log10(Math.max(1, vph)) * 30;
  return Math.round(vphScore + recencyBonus);
}

// Fallback search using direct InnerTube if YouTube.js session is bootstrapping
async function fallbackInnerTubeSearch(query, filterParam = null) {
  try {
    const htmlRes = await fetch('https://www.youtube.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await htmlRes.text();
    const apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
    const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
    if (!apiKey || !clientVersion) return [];

    const body = {
      context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
      query
    };
    if (filterParam) body.params = filterParam;

    const resp = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${apiKey}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const results = [];
    for (const c of contents) {
      if (c.itemSectionRenderer?.contents) {
        for (const item of c.itemSectionRenderer.contents) {
          const vr = item.videoRenderer;
          if (vr?.videoId) {
            results.push({
              id: vr.videoId,
              title: vr.title?.runs?.[0]?.text || '',
              channelTitle: vr.ownerText?.runs?.[0]?.text || '',
              viewsText: vr.viewCountText?.simpleText || '0 views',
              publishedText: vr.publishedTimeText?.simpleText || '',
              duration: vr.lengthText?.simpleText || '',
              thumbnail: vr.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`
            });
          }
        }
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

async function searchKeyword(yt, keyword) {
  if (yt) {
    try {
      const search = await yt.search(keyword, { type: 'video' });
      const videos = [];
      for (const item of search.videos || []) {
        if (item.id) {
          videos.push({
            id: item.id,
            title: item.title?.text || '',
            channelTitle: item.author?.name || '',
            viewsText: item.view_count?.text || item.short_view_count?.text || '0 views',
            publishedText: item.published?.text || '',
            duration: item.duration?.text || '',
            thumbnail: item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`
          });
        }
      }
      if (videos.length > 0) return videos;
    } catch (e) {
      console.warn(`YouTube.js search failed for [${keyword}], falling back to raw InnerTube:`, e.message);
    }
  }

  // Fallback
  const wResults = await fallbackInnerTubeSearch(keyword, 'EgIIAw==');
  const dResults = await fallbackInnerTubeSearch(keyword);
  const seen = new Set();
  const merged = [];
  for (const v of [...wResults, ...dResults]) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      merged.push(v);
    }
  }
  return merged;
}

// Compress and write both uncompressed and Brotli files
function writeWithBrotli(filePath, dataString) {
  fs.writeFileSync(filePath, dataString, 'utf8');
  try {
    const buffer = Buffer.from(dataString, 'utf8');
    const compressed = zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 6
      }
    });
    fs.writeFileSync(`${filePath}.br`, compressed);
  } catch (e) {
    console.warn(`Brotli compression warning for ${filePath}:`, e.message);
  }
}

async function run() {
  const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('--sample');
  console.log(`\n🚀 Initializing Telemetry Sync Engine ${isDryRun ? '(DRY RUN / SAMPLE MODE)' : ''}...`);

  // 1. Initialize YouTube.js client
  let yt = null;
  if (Innertube) {
    try {
      yt = await Innertube.create({
        lang: 'en',
        location: 'US',
        retrieve_player: false
      });
      console.log('✅ YouTube.js InnerTube session successfully initialized.');
    } catch (e) {
      console.warn('⚠️ YouTube.js initialization failed, using resilient fallback:', e.message);
    }
  }

  // 2. Load Topics
  const topicsPath = path.join(__dirname, 'topics.json');
  if (!fs.existsSync(topicsPath)) {
    console.error('❌ topics.json not found in crawler directory!');
    process.exit(1);
  }
  const rawTopics = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
  let activeTopics = rawTopics.filter(t => t.enabled !== false && t.keywords && t.keywords.length > 0);
  if (isDryRun) {
    activeTopics = activeTopics.slice(0, 3); // Sample mode: first 3 topics
    console.log(`ℹ️ Sampling ${activeTopics.length} topics for dry run.`);
  }

  // 3. Load Previous State
  const dataPath = path.join(__dirname, 'pulse_data.json');
  let masterData = { snapshots: [], current_videos: [] };
  if (fs.existsSync(dataPath)) {
    try {
      masterData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (!masterData.snapshots) masterData.snapshots = [];
      if (!masterData.current_videos) masterData.current_videos = [];
    } catch (e) {
      console.warn('Warning: pulse_data.json is corrupt. Starting fresh.');
    }
  }

  const historyCache = new Map(masterData.current_videos.map(v => [v.id, v]));
  const videoCache = new Map(masterData.current_videos.map(v => [`${v.id}_${v.topic_id}`, v]));

  const newCurrentVideos = [];
  const currentSnapshot = { timestamp: new Date().toISOString(), topics: {} };

  // 4. Crawl Keywords
  for (const topic of activeTopics) {
    const keywords = isDryRun ? topic.keywords.slice(0, 2) : topic.keywords;
    let topicMaxVPH = 0;
    let topicScore = 0;

    for (const kw of keywords) {
      console.log(`[SyncEngine] Processing: ${topic.name} → "${kw}"`);
      const results = await searchKeyword(yt, kw);
      console.log(`  └ Extracted ${results.length} results.`);

      for (const v of results.slice(0, CRAWL_CONFIG.maxVideosPerKeyword)) {
        const currentViews = parseInt(v.viewsText.replace(/[^0-9]/g, ''), 10) || 1;
        const ageHours = parseAgeTextToHours(v.publishedText) || 720;
        const vph = ageHours > 0 ? Number((currentViews / ageHours).toFixed(1)) : 0;

        const cached = historyCache.get(v.id);
        let current_vph = cached ? (cached.current_vph || 0) : 0;
        let created_at = new Date().toISOString();

        if (cached) {
          created_at = cached.created_at || created_at;
          const timeDiffSecs = (new Date() - new Date(cached.last_seen)) / 1000;
          if (timeDiffSecs > 60) {
            const viewDelta = Math.max(0, currentViews - cached.views);
            current_vph = Number(((viewDelta / timeDiffSecs) * 3600).toFixed(1));
          }
        }

        let pulse_score = computePulseScore(vph, v.publishedText, topic.id);
        if (current_vph > vph) {
          pulse_score = Math.round(pulse_score * 1.5);
        }

        let momentum = 'Steady';
        let momentumScore = 0; // 0 = steady, 1 = rising, 2 = surging, -1 = fading
        if (current_vph > 1.4 * vph && current_vph > 30) {
          momentum = 'Surging';
          momentumScore = 2;
        } else if (current_vph > 1.1 * vph) {
          momentum = 'Rising';
          momentumScore = 1;
        } else if (current_vph < 0.6 * vph && ageHours > 12) {
          momentum = 'Fading';
          momentumScore = -1;
        }

        topicMaxVPH = Math.max(topicMaxVPH, vph);
        topicScore += pulse_score;

        let targetTopicId = topic.id;
        const isMovieKeyword = kw.toLowerCase().includes('movie') || kw.toLowerCase().includes('film');
        const isMovieGroup = ['bollywood_cinema', 'hollywood_cinema'].includes(topic.id) || isMovieKeyword;
        if (isMovieGroup && v.duration && v.duration.split(':').length === 3) {
          targetTopicId = 'full_movies';
        }

        newCurrentVideos.push({
          id: v.id,
          topic_id: targetTopicId,
          keyword: kw,
          title: v.title,
          channel_title: v.channelTitle,
          published_time: v.publishedText,
          duration: v.duration,
          thumbnail: v.thumbnail,
          views: currentViews,
          vph,
          current_vph,
          performance: pulse_score,
          momentum,
          momentum_score: momentumScore,
          created_at,
          last_seen: new Date().toISOString()
        });
      }

      await new Promise(r => setTimeout(r, 200)); // Courteous pacing
    }

    currentSnapshot.topics[topic.id] = {
      maxVPH: topicMaxVPH,
      totalScore: topicScore
    };
  }

  // 5. Deduplicate and merge history
  const dedupedVideos = [];
  const seenIds = new Set();
  for (const v of newCurrentVideos) {
    const key = `${v.id}_${v.topic_id}`;
    if (!seenIds.has(key)) {
      seenIds.add(key);
      dedupedVideos.push(v);
    }
  }

  for (const oldV of videoCache.values()) {
    const key = `${oldV.id}_${oldV.topic_id}`;
    if (!seenIds.has(key)) {
      const hoursSinceSeen = (new Date() - new Date(oldV.last_seen)) / (1000 * 60 * 60);
      if (hoursSinceSeen < 48) {
        seenIds.add(key);
        dedupedVideos.push(oldV);
      }
    }
  }

  // 6. Viral Shelf Tagging
  const occurrences = {};
  for (const v of dedupedVideos) occurrences[v.id] = (occurrences[v.id] || 0) + 1;
  const viralVideosMap = {};
  const videosByTopic = {};

  for (const v of dedupedVideos) {
    if (occurrences[v.id] > 1) {
      const existing = viralVideosMap[v.id];
      if (!existing || (v.current_vph || 0) > (existing.current_vph || 0)) {
        v.topic_id = 'viral';
        viralVideosMap[v.id] = v;
      }
    } else {
      if (!videosByTopic[v.topic_id]) videosByTopic[v.topic_id] = [];
      videosByTopic[v.topic_id].push(v);
    }
  }

  if (Object.keys(viralVideosMap).length > 0) {
    if (!videosByTopic['viral']) videosByTopic['viral'] = [];
    videosByTopic['viral'].push(...Object.values(viralVideosMap));
  }

  let finalVideos = [];
  for (const topicId in videosByTopic) {
    videosByTopic[topicId].sort((a, b) => b.performance - a.performance);
    finalVideos = finalVideos.concat(videosByTopic[topicId].slice(0, 1000));
  }
  finalVideos.sort((a, b) => b.performance - a.performance);
  masterData.current_videos = finalVideos;

  masterData.snapshots.push(currentSnapshot);
  if (masterData.snapshots.length > CRAWL_CONFIG.historySnapshotsLimit) {
    masterData.snapshots.shift();
  }

  // 7. Write Master Analytical Data (`pulse_data.json` + Brotli)
  writeWithBrotli(dataPath, JSON.stringify(masterData, null, 2));
  console.log(`✅ Master analytical data written to ${dataPath} (+ .br)`);

  // 8. Generate Legacy-Compatible Compressed TV Feed (`tv_feed_latest.json`)
  const tvFeed = {};
  const shelvesDir = path.join(__dirname, 'shelves');
  if (!fs.existsSync(shelvesDir)) fs.mkdirSync(shelvesDir, { recursive: true });

  const shelfIndex = [];

  for (const topicId in videosByTopic) {
    const topicVids = videosByTopic[topicId];
    const sorted = [...topicVids].sort((a, b) => {
      const cvphB = parseFloat(b.current_vph) || 0;
      const cvphA = parseFloat(a.current_vph) || 0;
      if (cvphB === cvphA) return (parseFloat(b.performance) || 0) - (parseFloat(a.performance) || 0);
      return cvphB - cvphA;
    });

    const compactArray = sorted.map(v => [
      v.id,
      v.title,
      v.channel_title,
      v.views,
      v.published_time,
      v.duration,
      Number((v.vph || 0).toFixed(1)),
      Number((v.performance || 0).toFixed(2)),
      v.momentum_score || 0, // momentum score (2=Surging, 1=Rising, 0=Steady, -1=Fading)
      Number((v.current_vph || 0).toFixed(1))
    ]);

    tvFeed[topicId] = compactArray;

    // 9. Generate Chunked Shelf JSON (~15-30 KB)
    const shelfFile = path.join(shelvesDir, `${topicId}.json`);
    writeWithBrotli(shelfFile, JSON.stringify(compactArray));

    shelfIndex.push({
      topic_id: topicId,
      video_count: compactArray.length,
      spotlight: compactArray.slice(0, 3)
    });
  }

  const tvFeedPath = path.join(__dirname, 'tv_feed_latest.json');
  writeWithBrotli(tvFeedPath, JSON.stringify(tvFeed));
  console.log(`✅ Full TV feed written to ${tvFeedPath} (+ .br)`);

  const shelfIndexPath = path.join(__dirname, 'shelves_index.json');
  writeWithBrotli(shelfIndexPath, JSON.stringify(shelfIndex));
  console.log(`✅ Chunked shelf index (${shelfIndex.length} shelves) written to ${shelfIndexPath} (+ .br)`);

  console.log('\n🎉 Crawler execution completed successfully.');
}

run().catch(e => {
  console.error('Fatal crawler error:', e);
  process.exit(1);
});
