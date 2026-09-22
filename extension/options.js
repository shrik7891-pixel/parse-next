// ============================================================
// PulseTube Options Page controller - YOUTUBE CLONE EDITION
// ============================================================

const STORAGE_PREFIX = 'pt_';


// Seed topics array — 40 research-backed multilingual groups covering all world niches and family entertainment



// Robust storage and runtime wrappers that handle both Chrome Extension and Standard Web Preview seamlessly
const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) 
  ? {
      get: (keys) => new Promise((resolve) => {
        chrome.storage.local.get(keys, (res) => {
          if (chrome.runtime.lastError) console.error("Storage GET Error:", chrome.runtime.lastError);
          resolve(res || {});
        });
      }),
      set: (obj) => new Promise((resolve) => {
        chrome.storage.local.set(obj, () => {
          if (chrome.runtime.lastError) {
            console.error("Storage SET Error:", chrome.runtime.lastError);
            alert("Error saving data: " + chrome.runtime.lastError.message);
          }
          resolve(true);
        });
      }),
      remove: (keys) => new Promise((resolve) => {
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) console.error("Storage REMOVE Error:", chrome.runtime.lastError);
          resolve(true);
        });
      })
    }
  : {
      get: async (keys) => {
        const res = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(k => {
          const val = localStorage.getItem(k);
          try {
            res[k] = val ? JSON.parse(val) : undefined;
          } catch(e) {
            res[k] = val;
          }
        });
        // Default seed fallback if not configured
        if (!res[`pt_supabase_url`]) {
          res[`pt_supabase_url`] = 'http://127.0.0.1:8085';
        }
        if (!res[`pt_supabase_key`]) {
          res[`pt_supabase_key`] = '';
        }
        if (!res[`pt_topics`]) {
          res[`pt_topics`] = SEED_TOPICS;
        }
        return res;
      },
      set: async (obj) => {
        Object.keys(obj).forEach(k => {
          localStorage.setItem(k, JSON.stringify(obj[k]));
        });
        return true;
      },
      remove: async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(k => localStorage.removeItem(k));
        return true;
      }
    };

async function getLocalServerUrl() {
  const result = await storage.get(`${STORAGE_PREFIX}supabase_url`);
  let raw = result[`${STORAGE_PREFIX}supabase_url`] || SUPABASE_CONFIG.url;
  
  // Force override old local server overrides to align with background.js
  if (raw.includes('127.0.0.1') || raw.includes('localhost') || raw.includes('8085')) {
    raw = SUPABASE_CONFIG.url;
    await storage.set({ [`${STORAGE_PREFIX}supabase_url`]: raw });
  }
  
  raw = raw.trim().replace(/\/+$/, '');
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    raw = 'http://' + raw;
  }
  return raw;
}

const runtime = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage)
  ? chrome.runtime
  : {
      sendMessage: (msg, callback) => {
        console.log('[PulseTube Options Web] Mocked message sent:', msg);
        if (callback) {
          setTimeout(() => {
            callback({ success: true });
          }, 500);
        }
      },
      openOptionsPage: () => {
        window.location.reload();
      }
    };

// Global states
let allVideos = [];
let allTopics = [];
let selectedSort = 'current_vph'; // 'pulse_score' | 'vph' | 'performance' | 'current_vph' | 'views'
let selectedTopicFilter = null; // null means all topics (Home Feed)

document.addEventListener('DOMContentLoaded', async () => {
  setupSidebarNavigation();
  setupTagFilters();
  await loadCredentials();
  await loadTopics();
  await loadDashboardFeed();
  updateCrawlStatus();
  setupEventListeners();
  checkActiveCrawlProgress();

  if (typeof chrome !== 'undefined' && chrome.alarms) {
    chrome.alarms.get('pulse_crawl_alarm', (alarm) => {
      const dropdown = document.getElementById('auto-scan-interval');
      if (dropdown) {
        dropdown.value = alarm ? Math.round(alarm.periodInMinutes) : "0";
      }
    });
  }

  const syncResult = await storage.get(`${STORAGE_PREFIX}tv_sync_enabled`);
  const tvSyncDropdown = document.getElementById('tv-sync-enabled');
  if (tvSyncDropdown) {
    tvSyncDropdown.value = syncResult[`${STORAGE_PREFIX}tv_sync_enabled`] !== false ? "true" : "false";
  }

  const syncMinuteResult = await storage.get(`${STORAGE_PREFIX}cloud_sync_minute`);
  const syncMinuteEl = document.getElementById('cloud-sync-minute');
  if (syncMinuteEl) {
    syncMinuteEl.value = syncMinuteResult[`${STORAGE_PREFIX}cloud_sync_minute`] !== undefined ? syncMinuteResult[`${STORAGE_PREFIX}cloud_sync_minute`] : "15";
  }

  // Handle Profile Switching
  const curProfRes = await storage.get('active_profile');
  const activeProfile = curProfRes.active_profile || 'pt_';
  const profileSwitcher = document.getElementById('profile-switcher');
  if (profileSwitcher) {
    profileSwitcher.value = activeProfile;
    profileSwitcher.addEventListener('change', async (e) => {
      const newProfile = e.target.value;
      const oldProfile = activeProfile;
      if (newProfile === oldProfile) return;

      const keysToSwap = ['topics', 'videos', 'last_crawl_time', 'tv_sync_enabled', 'selectedSort'];
      
      const currentPtKeys = keysToSwap.map(k => `${STORAGE_PREFIX}${k}`);
      const currentData = await storage.get(currentPtKeys);
      
      const targetSavedKeys = keysToSwap.map(k => `${newProfile}saved_${k}`);
      const targetData = await storage.get(targetSavedKeys);

      const updates = {};
      
      // Save old profile state
      keysToSwap.forEach(k => {
        updates[`${oldProfile}saved_${k}`] = currentData[`${STORAGE_PREFIX}${k}`];
      });
      
      // Load new profile state into active pt_ keys
      keysToSwap.forEach(k => {
        let val = targetData[`${newProfile}saved_${k}`];
        if (val === undefined) {
           if (k === 'tv_sync_enabled') val = (newProfile === 'pt_'); // True for TV, False for Private
           if (k === 'topics' && newProfile === 'private_') val = []; // Empty, user creates own
        }
        updates[`${STORAGE_PREFIX}${k}`] = val;
      });
      
      updates['active_profile'] = newProfile;
      await storage.set(updates);
      window.location.reload();
    });
  }

  startServerConnectionMonitor();
});

// Continuously ping the backend to update the UI indicator
function startServerConnectionMonitor() {
  const checkConnection = async () => {
    const pill = document.getElementById('server-status-pill');
    const dot = document.getElementById('server-status-dot');
    const text = document.getElementById('server-status-text');
    if (!pill || !dot || !text) return;

    try {
      const res = await new Promise((resolve) => {
        runtime.sendMessage({ action: 'ping' }, resolve);
      });

      if (res && res.success) {
        pill.style.background = 'rgba(16, 185, 129, 0.08)';
        pill.style.borderColor = 'rgba(16, 185, 129, 0.2)';
        pill.style.color = '#10b981';
        dot.style.background = '#10b981';
        dot.style.boxShadow = '0 0 8px #10b981';
        dot.style.animation = 'pulse 2s infinite';
        text.innerText = 'Server Online';
      } else {
        throw new Error('Not OK');
      }
    } catch (e) {
      pill.style.background = 'rgba(239, 68, 68, 0.08)';
      pill.style.borderColor = 'rgba(239, 68, 68, 0.2)';
      pill.style.color = '#ef4444';
      dot.style.background = '#ef4444';
      dot.style.boxShadow = '0 0 8px #ef4444';
      dot.style.animation = 'none';
      text.innerText = 'Server Offline';
    }
  };

  // Check immediately, then every 30 seconds to save network overhead
  checkConnection();
  setInterval(checkConnection, 30000);
}

// ============================================================
// SPARKLINE — Inline SVG mini-chart from history data
// ============================================================
function buildSparklineSVG(keyword, field = 'performance') {
  if (!window.pulseHistory || window.pulseHistory.length === 0) return '';
  const hist = window.pulseHistory;
  if (hist.length === 1) {
    return `<div style="font-size:10px; color:var(--yt-text-muted); text-align:center; padding: 4px 0;">Collecting...</div>`;
  }
  
  const vals = hist.map(snapshot => {
    // Check if snapshot has metrics and keyword exists
    if (snapshot.metrics && snapshot.metrics[keyword] && snapshot.metrics[keyword][field]) {
      return snapshot.metrics[keyword][field];
    }
    return 0; // fallback if missing
  });

  const last12 = vals.slice(-12);
  if (last12.length < 2) return '';
  
  const min = Math.min(...last12);
  const max = Math.max(...last12);
  const range = max - min || 1;
  const w = 80, h = 24, pad = 2;
  
  const points = last12.map((v, i) => {
    const x = pad + (i / (last12.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  
  const delta = last12[last12.length - 1] - last12[0];
  const color = delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : '#888';
  const fillColor = delta > 0 ? 'rgba(34,197,94,0.15)' : delta < 0 ? 'rgba(239,68,68,0.15)' : 'rgba(136,136,136,0.1)';
  
  const firstX = (pad).toFixed(1);
  const lastX = (pad + ((last12.length - 1) / (last12.length - 1)) * (w - pad * 2)).toFixed(1);
  const areaPoints = `${firstX},${h - pad} ${points} ${lastX},${h - pad}`;
  
  return `<svg class="sparkline-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="background: rgba(0,0,0,0.2); border-radius: 4px; padding: 2px;">
    <polygon points="${areaPoints}" fill="${fillColor}"/>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last12.length > 0 ? lastX : 0}" cy="${last12.length > 0 ? (h - pad - ((last12[last12.length - 1] - min) / range) * (h - pad * 2)).toFixed(1) : 0}" r="2.5" fill="${color}"/>
  </svg>`;
}

// Setup sidebar tabs & active states
function setupSidebarNavigation() {
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-target');
      if (!target) return; // Special triggers like crawl buttons

      if (target === 'home') {
        selectedTopicFilter = null;
      }
      switchView(target);
      
      // Update sidebar highlight
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Logo home click listener
  document.getElementById('logo-home-trigger').addEventListener('click', (e) => {
    e.preventDefault();
    selectedTopicFilter = null;
    switchView('home');
    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    document.getElementById('side-home').classList.add('active');
    renderDashboardFeed();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function switchView(target) {
  // Hide all sections
  document.querySelectorAll('.video-section, .watch-viewport, .config-section').forEach(el => {
    el.classList.remove('active');
  });

  // Stop video playback if leaving watch page
  if (target !== 'watch') {
    const slot = document.getElementById('watch-player-slot');
    if (slot) slot.innerHTML = '';
  }

  // Activate target section
  const activeEl = document.getElementById(`view-${target}`);
  if (activeEl) {
    activeEl.classList.add('active');
  }

  if (target === 'home') {
    renderDashboardFeed();
  } else if (target === 'cig') {
    renderCigGrid();
  } else if (target === 'keywords') {
    loadTopics();
  }
}

// Tag Filters pill bar
async function setupTagFilters() {
  // Load persisted sort preference
  const res = await storage.get(`${STORAGE_PREFIX}selectedSort`);
  const curProfRes = await storage.get('active_profile');
  const activeProfile = curProfRes.active_profile || 'pt_';

  if (activeProfile === 'pt_') {
    selectedSort = 'current_vph'; // Default
  } else if (res[`${STORAGE_PREFIX}selectedSort`]) {
    selectedSort = res[`${STORAGE_PREFIX}selectedSort`];
  }

  document.querySelectorAll('.tag-pill').forEach(p => {
    if (p.getAttribute('data-sort') === selectedSort) {
      document.querySelectorAll('.tag-pill').forEach(px => px.classList.remove('active'));
      p.classList.add('active');
    }
  });

  document.querySelectorAll('.tag-pill').forEach(pill => {
    pill.addEventListener('click', async () => {
      document.querySelectorAll('.tag-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      
      selectedSort = pill.getAttribute('data-sort');
      await storage.set({ [`${STORAGE_PREFIX}selectedSort`]: selectedSort });
      renderDashboardFeed();
    });
  });
}

// Direct query to GitHub CDN
async function queryLocalServer() {
  const result = await storage.get([`${STORAGE_PREFIX}github_repo`]);
  const repo = result[`${STORAGE_PREFIX}github_repo`] || 'shrik7891-pixel/pulsetube-next';
  
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/live-data/pulse_data.json?t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      // Attach the snapshot history to the window object so we can use it for Sparklines and Momentum!
      window.pulseHistory = data.snapshots || [];
      if (data.snapshots && data.snapshots.length > 0) {
        const lastSnap = data.snapshots[data.snapshots.length - 1];
        await storage.set({ [`${STORAGE_PREFIX}last_crawl_time`]: new Date(lastSnap.timestamp).getTime() });
        updateCrawlStatus(); // Refresh UI pill
      }
      return { videos_feed: data.current_videos || [] };
    }
  } catch (e) {
    console.error('GitHub CDN fetch error:', e);
  }
  return null;
}

// Load credentials
async function loadCredentials() {
  const result = await storage.get([
    `${STORAGE_PREFIX}github_repo`,
    `${STORAGE_PREFIX}github_token`
  ]);
  const ghRepo = result[`${STORAGE_PREFIX}github_repo`] || '';
  const ghToken = result[`${STORAGE_PREFIX}github_token`] || '';
  
  if(document.getElementById('gh-repo') && ghRepo) {
    document.getElementById('gh-repo').value = ghRepo;
  }
  if(document.getElementById('gh-token') && ghToken) {
    document.getElementById('gh-token').value = ghToken;
  }
}

// Load keyword categories and dynamically populate left sidebar & table
async function loadTopics(skipServerSync = false) {
  let topics = [];
  try {
    if (!skipServerSync) {
      // 1. Fetch Master List from GitHub (new source of truth)
      const result = await storage.get([`${STORAGE_PREFIX}github_repo`, `${STORAGE_PREFIX}github_token`]);
      const repo = result[`${STORAGE_PREFIX}github_repo`] || 'shrik7891-pixel/pulsetube-next';
      const token = result[`${STORAGE_PREFIX}github_token`];
      
      const headers = { 'Accept': 'application/vnd.github.v3+json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const githubRes = await fetch(`https://api.github.com/repos/${repo}/contents/topics.json`, {
          headers: headers
      });
      if (githubRes.ok) {
          const fileData = await githubRes.json();
          const decodedContent = decodeURIComponent(escape(atob(fileData.content)));
          const githubTopics = JSON.parse(decodedContent);
          
          if (githubTopics && githubTopics.length > 0) {
              const localResult = await storage.get(`${STORAGE_PREFIX}topics`);
              const localTopics = localResult[`${STORAGE_PREFIX}topics`] || [];
              const localMap = new Map(localTopics.map(t => [t.id, t]));
              
              const mergedTopics = [];
              
              githubTopics.forEach(t => {
                  const localItem = localMap.get(t.id);
                  if (localItem) {
                      // Always preserve local modifications unconditionally
                      mergedTopics.push(localItem);
                      localMap.delete(t.id);
                  } else {
                      const seedItem = typeof SEED_TOPICS !== 'undefined' ? SEED_TOPICS.find(s => s.id === t.id) : null;
                      if (!t.keywords || t.keywords.length === 0) {
                          t.keywords = seedItem && seedItem.keywords ? seedItem.keywords : [];
                      }
                      mergedTopics.push(t);
                  }
              });
              
              // Keep any custom user-created groups that aren't on GitHub yet
              localMap.forEach(localItem => mergedTopics.push(localItem));
              
              mergedTopics.sort((a,b) => (a.position||0) - (b.position||0));
              topics = mergedTopics;
              
              await storage.set({ [`${STORAGE_PREFIX}topics`]: topics });
              console.log('[PulseTube] Synced latest topics from GitHub master copy.');
          }
      }
    }
  } catch (err) {
    console.warn('[PulseTube] Could not reach Supabase to sync topics, using local cache.');
  }

  // Fallback to local storage if server fetch failed or was empty
  if (topics.length === 0) {
    const result = await storage.get(`${STORAGE_PREFIX}topics`);
    topics = result[`${STORAGE_PREFIX}topics`] || [];
  }
  
  allTopics = topics;

  // 2. Populate Left Sidebar
  const sidebarContainer = document.getElementById('sidebar-topics-list');
  sidebarContainer.innerHTML = '';

  const activeTopics = topics.filter(t => t.enabled !== false);
  
  // Render "Viral" in the sidebar if it exists, without polluting storage
  if (typeof allVideos !== 'undefined' && allVideos && allVideos.some(v => v.topic_id === 'viral')) {
      const vItem = document.createElement('div');
      vItem.className = 'sidebar-item viral-item';
      if (selectedTopicFilter === 'viral') vItem.classList.add('active');
      vItem.innerHTML = `<span class="sidebar-item-icon">🔥</span> Viral Everywhere`;
      vItem.addEventListener('click', () => {
        selectedTopicFilter = 'viral';
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        vItem.classList.add('active');
        switchView('home');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      sidebarContainer.appendChild(vItem);
  }
  
  if (activeTopics.length === 0) {
    sidebarContainer.innerHTML = `
      <div style="font-size:0.8rem; color:var(--yt-text-muted); padding:0.5rem 0.75rem;">No active shelves</div>
    `;
  } else {
    let draggedItem = null;

    activeTopics.forEach(topic => {
      const item = document.createElement('div');
      item.className = 'sidebar-item';
      item.draggable = true;
      item.style.cursor = 'grab';
      
      if (selectedTopicFilter === topic.id) {
        item.classList.add('active');
      }
      item.innerHTML = `<span class="sidebar-item-icon">${topic.icon || '📌'}</span> ${topic.name}`;
      
      item.addEventListener('click', () => {
        selectedTopicFilter = topic.id;
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        switchView('home');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });

      // Drag and Drop implementation
      item.addEventListener('dragstart', function(e) {
        draggedItem = this;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => this.style.opacity = '0.5', 0);
      });

      item.addEventListener('dragover', function(e) {
        e.preventDefault();
        this.style.boxShadow = 'inset 0 2px 0 #60a5fa';
        return false;
      });

      item.addEventListener('dragleave', function() {
        this.style.boxShadow = '';
      });

      item.addEventListener('drop', async function(e) {
        e.stopPropagation();
        this.style.boxShadow = '';
        
        if (draggedItem !== this) {
          const children = Array.from(sidebarContainer.children).filter(el => !el.classList.contains('viral-item'));
          const targetIndex = children.indexOf(this);
          const sourceIndex = children.indexOf(draggedItem);
          
          if (targetIndex >= 0 && sourceIndex >= 0) {
            const movedTopic = activeTopics.splice(sourceIndex, 1)[0];
            activeTopics.splice(targetIndex, 0, movedTopic);
            
            const inactiveTopics = topics.filter(t => t.enabled === false);
            const newTopics = [...activeTopics, ...inactiveTopics];
            newTopics.forEach((t, i) => t.position = i);
            
            await storage.set({ [`${STORAGE_PREFIX}topics`]: newTopics });
            await loadTopics(true);
            
            const autoSync = document.getElementById('sync-gh-auto')?.checked ?? true;
            if (autoSync) {
              syncTopicsToGitHub(newTopics);
            }
          }
        }
        return false;
      });

      item.addEventListener('dragend', function() {
        this.style.opacity = '1';
        document.querySelectorAll('.sidebar-item').forEach(i => i.style.boxShadow = '');
      });

      sidebarContainer.appendChild(item);
    });
  }

  // 2. Populate Config Table
  const tbody = document.getElementById('topics-tbody');
  tbody.innerHTML = '';

  if (topics.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--yt-text-muted); padding: 2rem;">
          No keyword groups configured yet. Click "+ Add Group" to create one, or "Restore Defaults" to load standard shelves.
        </td>
      </tr>
    `;
    return;
  }

  let highestPerf = 0;
  let topShelfName = '-';

  topics.forEach((topic, index) => {
    const tr = document.createElement('tr');
    
    // Icon
    const iconTd = document.createElement('td');
    iconTd.style.textAlign = 'center';
    iconTd.style.fontSize = '1.25rem';
    iconTd.innerText = topic.icon || '📌';
    tr.appendChild(iconTd);

    // Name
    const nameTd = document.createElement('td');
    nameTd.style.fontWeight = '700';
    nameTd.style.color = '#fff';
    nameTd.innerText = topic.name;
    tr.appendChild(nameTd);

    // Keywords (Collapsed Pill)
    const kwTd = document.createElement('td');
    const kwArray = topic.keywords || [];
    
    const kwBadge = document.createElement('span');
    kwBadge.className = 'keyword-badge';
    kwBadge.style.background = 'rgba(96, 165, 250, 0.1)';
    kwBadge.style.borderColor = 'rgba(96, 165, 250, 0.2)';
    kwBadge.style.color = '#60a5fa';
    kwBadge.style.cursor = 'pointer';
    kwBadge.style.display = 'inline-flex';
    kwBadge.style.alignItems = 'center';
    kwBadge.style.gap = '0.3rem';
    kwBadge.style.padding = '0.4rem 0.8rem';
    kwBadge.innerHTML = `<span>🏷️</span> <span>${kwArray.length} Keywords</span>`;
    kwBadge.title = "Click to edit keywords";
    kwBadge.onclick = () => openEditModal(topic);
    
    kwTd.appendChild(kwBadge);
    tr.appendChild(kwTd);

    // Compute metrics from the active allVideos array
    const topicVideos = (allVideos || []).filter(v => v.topic_id === topic.id);
    const videoCount = topicVideos.length;
    
    let avgPerf = 1.0;
    if (videoCount > 0) {
      const sum = topicVideos.reduce((acc, curr) => acc + (curr.performance || 1.0), 0);
      avgPerf = sum / videoCount;

      if (avgPerf > highestPerf) {
        highestPerf = avgPerf;
        topShelfName = topic.icon ? `${topic.icon} ${topic.name}` : topic.name;
      }
    }

    // Videos Indexed Count
    const countTd = document.createElement('td');
    countTd.style.textAlign = 'center';
    countTd.innerHTML = `
      <span style="background: rgba(255, 255, 255, 0.06); padding: 0.3rem 0.75rem; border-radius: 12px; font-weight: bold; font-size: 0.82rem; border: 1px solid rgba(255, 255, 255, 0.08); color: #fff; display: inline-block;">
        📊 ${videoCount}
      </span>
    `;
    tr.appendChild(countTd);

    // Avg Performance Multiplier
    const perfTd = document.createElement('td');
    perfTd.style.textAlign = 'center';
    let badgeColor = '#ff5b5b';
    let badgeBg = 'rgba(255, 91, 91, 0.08)';
    let badgeBorder = 'rgba(255, 91, 91, 0.15)';
    if (avgPerf >= 1.5) {
      badgeColor = '#4ade80';
      badgeBg = 'rgba(74, 222, 128, 0.08)';
      badgeBorder = 'rgba(74, 222, 128, 0.15)';
    } else if (avgPerf >= 1.1) {
      badgeColor = '#facc15';
      badgeBg = 'rgba(250, 204, 21, 0.08)';
      badgeBorder = 'rgba(250, 204, 21, 0.15)';
    }
    perfTd.innerHTML = `
      <span style="color: ${badgeColor}; background: ${badgeBg}; border: 1px solid ${badgeBorder}; padding: 0.3rem 0.75rem; border-radius: 12px; font-weight: bold; font-size: 0.82rem; display: inline-block;">
        🔥 ${avgPerf.toFixed(2)}x
      </span>
    `;
    tr.appendChild(perfTd);

    // Switch check
    const activeTd = document.createElement('td');
    activeTd.style.textAlign = 'center';
    activeTd.innerHTML = `
      <label class="switch">
        <input type="checkbox" class="toggle-active" data-id="${topic.id}" ${topic.enabled !== false ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    `;
    tr.appendChild(activeTd);

    // Actions
    const actionsTd = document.createElement('td');
    
    const flexWrapper = document.createElement('div');
    flexWrapper.style.display = 'flex';
    flexWrapper.style.alignItems = 'center';
    flexWrapper.style.justifyContent = 'flex-end';
    flexWrapper.style.gap = '0.5rem';
    flexWrapper.style.flexWrap = 'nowrap';
    
    const reorderGroup = document.createElement('div');
    reorderGroup.style.display = 'flex';
    reorderGroup.style.flexDirection = 'column';
    reorderGroup.style.gap = '2px';
    
    const dragHandle = document.createElement('span');
    dragHandle.innerHTML = '☰';
    dragHandle.style.cursor = 'grab';
    dragHandle.style.color = 'rgba(255,255,255,0.4)';
    dragHandle.style.fontSize = '1.1rem';
    dragHandle.style.paddingLeft = '0.3rem';
    dragHandle.title = 'Drag to reorder';
    
    // Drag and Drop Logic
    tr.draggable = true;
    tr.dataset.index = index;
    
    tr.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index);
      tr.style.opacity = '0.4';
    });
    
    tr.addEventListener('dragend', (e) => {
      tr.style.opacity = '1';
      document.querySelectorAll('#topics-tbody tr').forEach(row => {
        row.style.borderTop = '';
        row.style.borderBottom = '';
      });
    });
    
    tr.addEventListener('dragover', (e) => {
      e.preventDefault(); // Necessary to allow dropping
      e.dataTransfer.dropEffect = 'move';
      
      const bounding = tr.getBoundingClientRect();
      const offset = bounding.y + (bounding.height / 2);
      if (e.clientY - offset > 0) {
        tr.style.borderBottom = '2px solid #60a5fa';
        tr.style.borderTop = '';
      } else {
        tr.style.borderTop = '2px solid #60a5fa';
        tr.style.borderBottom = '';
      }
    });
    
    tr.addEventListener('dragleave', (e) => {
      tr.style.borderTop = '';
      tr.style.borderBottom = '';
    });
    
    tr.addEventListener('drop', async (e) => {
      e.preventDefault();
      tr.style.borderTop = '';
      tr.style.borderBottom = '';
      
      const fromIndexStr = e.dataTransfer.getData('text/plain');
      if (!fromIndexStr) return;
      const fromIndex = parseInt(fromIndexStr, 10);
      let toIndex = index;
      
      const bounding = tr.getBoundingClientRect();
      const offset = bounding.y + (bounding.height / 2);
      if (e.clientY - offset > 0) {
        toIndex = index + 1;
      }
      
      if (fromIndex === toIndex || fromIndex + 1 === toIndex) return;
      
      await reorderGroups(fromIndex, toIndex);
    });

    // Right-click context menu for Send to Top / Send to Bottom
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      
      // Remove any existing context menus
      const existingMenu = document.getElementById('custom-context-menu');
      if (existingMenu) existingMenu.remove();
      
      const menu = document.createElement('div');
      menu.id = 'custom-context-menu';
      menu.style.position = 'fixed';
      menu.style.top = `${e.clientY}px`;
      menu.style.left = `${e.clientX}px`;
      menu.style.background = '#1e1e1e';
      menu.style.border = '1px solid rgba(255,255,255,0.1)';
      menu.style.borderRadius = '8px';
      menu.style.padding = '0.5rem';
      menu.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
      menu.style.zIndex = '9999';
      menu.style.display = 'flex';
      menu.style.flexDirection = 'column';
      menu.style.gap = '0.2rem';
      
      const createMenuBtn = (text, icon, onClick) => {
        const btn = document.createElement('button');
        btn.innerHTML = `<span>${icon}</span> <span>${text}</span>`;
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.gap = '0.5rem';
        btn.style.padding = '0.5rem 1rem';
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.color = '#fff';
        btn.style.cursor = 'pointer';
        btn.style.borderRadius = '4px';
        btn.style.textAlign = 'left';
        btn.style.fontSize = '0.85rem';
        btn.style.width = '100%';
        btn.addEventListener('mouseover', () => btn.style.background = 'rgba(255,255,255,0.1)');
        btn.addEventListener('mouseout', () => btn.style.background = 'transparent');
        btn.addEventListener('click', onClick);
        return btn;
      };
      
      if (index > 0) {
        menu.appendChild(createMenuBtn('Send to Top', '⬆️', async () => {
          menu.remove();
          await reorderGroups(index, 0);
        }));
      }
      
      if (index < topics.length - 1) {
        menu.appendChild(createMenuBtn('Send to Bottom', '⬇️', async () => {
          menu.remove();
          await reorderGroups(index, topics.length);
        }));
      }
      
      if (menu.children.length > 0) {
        document.body.appendChild(menu);
        
        // Auto-close on click anywhere else
        setTimeout(() => {
          document.addEventListener('click', function clickAway() {
            if (document.getElementById('custom-context-menu')) {
              document.getElementById('custom-context-menu').remove();
            }
            document.removeEventListener('click', clickAway);
          });
        }, 10);
      }
    });
    
    const mainBtns = document.createElement('div');
    mainBtns.style.display = 'flex';
    mainBtns.style.gap = '0.3rem';
    
    const crawlBtn = document.createElement('button');
    crawlBtn.className = 'btn btn-secondary';
    crawlBtn.style.padding = '0.3rem 0.5rem';
    crawlBtn.style.fontSize = '0.8rem';
    crawlBtn.style.borderRadius = '6px';
    crawlBtn.style.border = '1px solid rgba(255,255,255,0.1)';
    crawlBtn.innerText = '🕷️';
    crawlBtn.title = 'Crawl this group';
    crawlBtn.onclick = () => crawlGroup(topic.id);
    mainBtns.appendChild(crawlBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary';
    editBtn.style.padding = '0.3rem 0.5rem';
    editBtn.style.fontSize = '0.8rem';
    editBtn.style.borderRadius = '6px';
    editBtn.style.border = '1px solid rgba(255,255,255,0.1)';
    editBtn.innerText = '✏️';
    editBtn.title = 'Edit this group';
    editBtn.onclick = () => openEditModal(topic);
    mainBtns.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn';
    deleteBtn.style.padding = '0.3rem 0.5rem';
    deleteBtn.style.fontSize = '0.8rem';
    deleteBtn.style.borderRadius = '6px';
    deleteBtn.style.background = 'rgba(239, 68, 68, 0.1)';
    deleteBtn.style.border = '1px solid rgba(239, 68, 68, 0.2)';
    deleteBtn.style.color = '#ef4444';
    deleteBtn.innerText = '🗑️';
    deleteBtn.title = 'Delete this group';
    deleteBtn.onclick = () => deleteGroup(topic.id);
    mainBtns.appendChild(deleteBtn);
    
    flexWrapper.appendChild(mainBtns);
    flexWrapper.appendChild(dragHandle);
    actionsTd.appendChild(flexWrapper);

    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });

  // Update System Analytics Dashboard
  if (document.getElementById('stat-total-videos')) {
    const totalVideos = allVideos ? allVideos.length : 0;
    document.getElementById('stat-total-videos').innerText = totalVideos;
    
    let globalAvgPerf = 1.0;
    if (totalVideos > 0) {
      const sum = allVideos.reduce((acc, curr) => acc + (curr.performance || 1.0), 0);
      globalAvgPerf = sum / totalVideos;
    }
    
    const globalPerfEl = document.getElementById('stat-global-perf');
    globalPerfEl.innerText = `${globalAvgPerf.toFixed(2)}x`;
    if (globalAvgPerf >= 1.5) {
      globalPerfEl.style.color = '#4ade80';
    } else if (globalAvgPerf >= 1.1) {
      globalPerfEl.style.color = '#facc15';
    } else {
      globalPerfEl.style.color = '#ff5b5b';
    }
    
    let totalKeywords = 0;
    topics.forEach(t => {
      if (t.keywords) totalKeywords += t.keywords.length;
    });

    document.getElementById('stat-top-shelf').innerText = topShelfName;
    document.getElementById('stat-total-keywords').innerText = totalKeywords.toLocaleString();
    document.getElementById('stat-active-topics').innerText = `${activeTopics.length} / ${topics.length}`;
  }

  // Attach toggle listener
  document.querySelectorAll('.toggle-active').forEach(toggle => {
    toggle.addEventListener('change', async (e) => {
      const id = e.target.getAttribute('data-id');
      const enabled = e.target.checked;
      await toggleTopicState(id, enabled);
    });
  });
}

async function toggleTopicState(id, enabled) {
  const result = await storage.get(`${STORAGE_PREFIX}topics`);
  const topics = result[`${STORAGE_PREFIX}topics`] || [];
  
  const updated = topics.map(t => {
    if (t.id === id) t.enabled = enabled;
    return t;
  });

  await storage.set({ [`${STORAGE_PREFIX}topics`]: updated });
  await loadTopics();
  runtime.sendMessage({ action: 'sync_topics' }, () => {});
}

async function moveGroup(index, direction) {
  const result = await storage.get(`${STORAGE_PREFIX}topics`);
  const topics = result[`${STORAGE_PREFIX}topics`] || [];
  
  if (index < 0 || index >= topics.length || index + direction < 0 || index + direction >= topics.length) return;
  
  // Swap elements
  const temp = topics[index];
  topics[index] = topics[index + direction];
  topics[index + direction] = temp;
  
  // Update internal positions
  topics.forEach((t, i) => t.position = i);
  
  await storage.set({ [`${STORAGE_PREFIX}topics`]: topics });
  await loadTopics(true);
  
  const autoSync = document.getElementById('sync-gh-auto')?.checked ?? true;
  if (autoSync) {
    syncTopicsToGitHub(topics);
  }
}

async function reorderGroups(fromIndex, toIndex) {
  const result = await storage.get(`${STORAGE_PREFIX}topics`);
  let topics = result[`${STORAGE_PREFIX}topics`] || [];
  
  const [movedItem] = topics.splice(fromIndex, 1);
  if (fromIndex < toIndex) {
    toIndex--;
  }
  topics.splice(toIndex, 0, movedItem);
  
  // Update internal positions
  topics.forEach((t, i) => t.position = i);
  
  await storage.set({ [`${STORAGE_PREFIX}topics`]: topics });
  await loadTopics(true);
  
  const autoSync = document.getElementById('sync-gh-auto')?.checked ?? true;
  if (autoSync) {
    syncTopicsToGitHub(topics);
  }
}

// ─── HOME GRID LOADER AND DEDUPLICATOR ───
  
async function loadDashboardFeed() {
  const container = document.getElementById('shelves-grid-container');
  
  // Show skeleton loading state
  container.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:2.5rem;">
      ${[1,2,3].map(() => `
        <div>
          <div style="height:1.5rem; width:220px; background:rgba(255,255,255,0.06); border-radius:8px; margin-bottom:1.25rem;"></div>
          <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:2rem 1.25rem;">
            ${[1,2,3,4].map(() => `
              <div>
                <div style="width:100%; padding-top:56.25%; background:rgba(255,255,255,0.06); border-radius:12px; margin-bottom:0.75rem; animation:shimmer 1.5s infinite;"></div>
                <div style="height:0.9rem; width:90%; background:rgba(255,255,255,0.05); border-radius:4px; margin-bottom:0.5rem;"></div>
                <div style="height:0.8rem; width:60%; background:rgba(255,255,255,0.04); border-radius:4px;"></div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  const result = await storage.get(`${STORAGE_PREFIX}topics`);
  const localTopics = result[`${STORAGE_PREFIX}topics`] || [];
  if (localTopics.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span>⚠️</span>
        <h3>Setup PulseTube Shelves</h3>
        <p>No keyword groups configured yet. Go to the "Keyword Shelves" tab to create your own groups or restore defaults.</p>
      </div>
    `;
    return;
  }

  // Instantly load cached videos if they exist
  const cacheRes = await storage.get(`${STORAGE_PREFIX}videos`);
  const cachedVideos = cacheRes[`${STORAGE_PREFIX}videos`] || [];
  if (cachedVideos.length > 0) {
    allVideos = cachedVideos;
    loadTopics(true);
    renderDashboardFeed();
  }

  // Fetch fresh videos from local DB / Supabase in the background
  queryLocalServer().then(dbData => {
    const supabaseVideos = dbData ? dbData.videos_feed : [];
    
    if (supabaseVideos && supabaseVideos.length > 0) {
      allVideos = supabaseVideos;
      loadTopics(true);
      
      // Update empty state if we previously showed it but now have videos
      if (cachedVideos.length === 0) {
        container.innerHTML = '';
      }
      
      renderDashboardFeed(); // Update UI with fresh data
      
      // Hydrate Active Keyword Groups table metrics with crawled database insights
      loadTopics().catch(e => console.error('Failed to update config stats:', e));
      
    } else if (cachedVideos.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span>🚀</span>
          <h3>No Videos Crawled Yet</h3>
          <p>Click the button below to scan YouTube for your keyword groups and populate the feed.</p>
          <button id="btn-empty-crawl" class="btn" style="margin-top:1.25rem; background:linear-gradient(135deg,#ff0000,#cc0000); border:none; color:#fff; padding:0.75rem 1.75rem; border-radius:25px; font-size:1rem; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; gap:0.5rem;">🚀 Run First Crawl</button>
        </div>
      `;
      document.getElementById('btn-empty-crawl')?.addEventListener('click', triggerManualCrawl);
    }
  });
}

function getRelativeTimeHtml(video) {
  let unixTimeMs = video.published_unix || 0;
  
  if (unixTimeMs === 0 && video.created_at && video.published_time) {
    const createdAtMs = new Date(video.created_at).getTime();
    let timeStr = video.published_time.toLowerCase().replace("streamed ", "").trim();
    let multiplier = 1;
    if (timeStr.includes("second")) multiplier = 1;
    else if (timeStr.includes("minute")) multiplier = 60;
    else if (timeStr.includes("hour")) multiplier = 3600;
    else if (timeStr.includes("day")) multiplier = 86400;
    else if (timeStr.includes("week")) multiplier = 604800;
    else if (timeStr.includes("month")) multiplier = 2592000;
    else if (timeStr.includes("year")) multiplier = 31536000;
    
    let num = parseInt(timeStr.split(" ")[0]);
    if (!isNaN(num)) {
      unixTimeMs = createdAtMs - (num * multiplier * 1000);
    }
  }

  if (unixTimeMs > 0) {
    const diffMs = Date.now() - unixTimeMs;
    const diffSecs = Math.floor(diffMs / 1000);
    
    if (diffSecs < 60) return `${Math.max(0, diffSecs)} seconds ago`;
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks < 4) return `${diffWeeks} week${diffWeeks > 1 ? 's' : ''} ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears} year${diffYears > 1 ? 's' : ''} ago`;
  }
  
  return video.published_time || 'recently';
}

let renderGlobalToken = 0;
async function renderDashboardFeed() {
  renderGlobalToken++;
  const myToken = renderGlobalToken;
  
  const container = document.getElementById('shelves-grid-container');
  container.innerHTML = '';
  
  const activeHeader = document.getElementById('active-shelf-header');
  if (activeHeader) activeHeader.innerHTML = '';

  const searchVal = document.getElementById('search-bar').value.toLowerCase().trim();
  const sortCol = selectedSort;

  const btnCrawlAll = document.getElementById('btn-crawl-all-home');
  if (btnCrawlAll) {
    btnCrawlAll.style.display = 'flex';
  }

  // Filter categories to display
  const activeTopics = allTopics.filter(t => t.enabled !== false);
  
  // Inject "Viral" strictly for dashboard rendering
  if (typeof allVideos !== 'undefined' && allVideos && allVideos.some(v => v.topic_id === 'viral')) {
    activeTopics.unshift({ id: 'viral', name: 'Viral Everywhere', icon: '🔥', enabled: true, position: -1 });
  }
  
  // If we have a sidebar topic filter active, only render that one! Otherwise show single Global Feed.
  const topicsToRender = selectedTopicFilter 
    ? activeTopics.filter(t => t.id === selectedTopicFilter)
    : [{ id: 'global_feed', name: 'Global Trending', icon: '🌐' }];

  if (topicsToRender.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span>📴</span>
        <h3>Category is Empty or Inactive</h3>
        <p>Enable keyword groups in the "Keyword Shelves" tab to display lists here.</p>
      </div>
    `;
    return;
  }

  let totalRendered = 0;
  
  const sortFeedVideos = (a, b) => {
    // 1. Handle Duration
    if (sortCol === 'duration_sec') {
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
    if (sortCol === 'published_unix') {
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
    const targetCol = sortCol === 'pulse_score' ? 'performance' : sortCol;
    const valA = parseFloat(a[targetCol]) || parseFloat(a['change_30m']) || 0;
    const valB = parseFloat(b[targetCol]) || parseFloat(b['change_30m']) || 0;
    
    // Explicit fallback: if values are tied (e.g. current_vph is 0), rank by the backend Pulse Score
    if (valA === valB && targetCol !== 'performance') {
      return (parseFloat(b.performance) || 0) - (parseFloat(a.performance) || 0);
    }
    
    return valB - valA;
  };

  let sourceVideos = allVideos;
  if (selectedTopicFilter === null) {
    // Fair Representation Algorithm: pool the top 15 videos from each active topic
    const grouped = {};
    allVideos.forEach(v => {
      if (!grouped[v.topic_id]) grouped[v.topic_id] = [];
      grouped[v.topic_id].push(v);
    });
    
    const fairPool = [];
    activeTopics.forEach(t => {
      const tvids = grouped[t.id] || [];
      tvids.sort(sortFeedVideos);
      fairPool.push(...tvids.slice(0, 15)); // top 15 per shelf
    });
    sourceVideos = fairPool;
  }

  // Set to globally deduplicate videos across all shelves on the Home Feed (when filter is null)
  const globalSeenVideoIds = new Set();

  for (const topic of topicsToRender) {
    if (renderGlobalToken !== myToken) return;

    // Deduplicate videos strictly by unique ID inside this specific topic shelf
    const uniqueVideosMap = new Map();
    
    sourceVideos.forEach(v => {
      if (topic.id === 'global_feed' || v.topic_id === topic.id) {
        // Prevent duplicate videos across different shelves (only relevant if we ever go back to multi-shelf)
        if (selectedTopicFilter === null && globalSeenVideoIds.has(v.id)) {
          return;
        }

        const matchesSearch = !searchVal || 
          v.title.toLowerCase().includes(searchVal) ||
          (v.channel_title && v.channel_title.toLowerCase().includes(searchVal)) ||
          topic.name.toLowerCase().includes(searchVal);

        if (matchesSearch) {
          if (!uniqueVideosMap.has(v.id)) {
            uniqueVideosMap.set(v.id, v);
          } else {
            // Keep the better performing one if there is an overlap
            const existing = uniqueVideosMap.get(v.id);
            const valExisting = parseFloat(existing[sortCol]) || 0;
            const valNew = parseFloat(v[sortCol]) || 0;
            if (valNew > valExisting) {
              uniqueVideosMap.set(v.id, v);
            }
          }
        }
      }
    });

    const shelfVideos = Array.from(uniqueVideosMap.values());

    // Sort the shelf videos
    shelfVideos.sort(sortFeedVideos);

    // Prevent massive DOM overload: Cap Home Feed rows to 150 videos, but show all if filtering by topic
    const displayVideos = selectedTopicFilter ? shelfVideos.slice(0, 1000) : shelfVideos.slice(0, 1000);

    if (displayVideos.length === 0 && selectedTopicFilter === null) continue;

    totalRendered++;

    // Add to global seen set to prevent duplicates in other shelves
    if (selectedTopicFilter === null) {
      displayVideos.forEach(v => globalSeenVideoIds.add(v.id));
    }

    // Create YouTube Style Shelf Row
    const section = document.createElement('div');
    section.style.marginBottom = '2.5rem';

    const actionsHtml = (selectedTopicFilter && topic.id !== 'viral') ? `
      <div style="display:flex; gap:0.5rem; align-items:flex-start;">
        <button class="btn btn-secondary shelf-action-btn" data-action="edit" data-topic="${topic.id}" style="padding:0.4rem 0.9rem; border-radius:30px; font-size:0.85rem; font-weight:600; display:flex; align-items:center; gap:0.4rem; white-space:nowrap; transition:all 0.2s;">✏️ Edit Keywords</button>
        <button class="btn shelf-action-btn" data-action="crawl" data-topic="${topic.id}" style="background:linear-gradient(135deg,#ff0000,#cc0000); border:none; color:#fff; padding:0.4rem 0.9rem; border-radius:30px; font-size:0.85rem; font-weight:600; display:flex; align-items:center; gap:0.4rem; white-space:nowrap; transition:all 0.2s; box-shadow: 0 2px 8px rgba(255,0,0,0.3);">🕷️ Crawl Shelf</button>
      </div>
    ` : '';

    if (selectedTopicFilter) {
      const headerEl = document.getElementById('active-shelf-header');
      if (headerEl) {
        headerEl.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 1.5rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 1.5rem;">
            <div class="shelf-group-header" style="margin:0; border:none; padding:0; display:flex; align-items:flex-start; gap:0.75rem;">
              <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; box-shadow: 0 4px 12px rgba(0,0,0,0.5); flex-shrink:0;">
                ${topic.icon || '📌'}
              </div>
              <div style="display:flex; flex-direction:column;">
                <span style="font-size: 1.5rem; letter-spacing: -0.02em; color:#fff; font-weight: 700; text-shadow: 0 2px 10px rgba(255,255,255,0.1);">${topic.name}</span>
                <span style="font-size:0.8rem; color:var(--yt-text-muted); font-weight:500; font-family: 'Inter', sans-serif;">
                  Displaying top ${displayVideos.length} of ${shelfVideos.length} trending videos sorted by ${sortCol.toUpperCase()}
                </span>
                <div id="active-shelf-keywords" style="margin-top: 0.5rem; display:flex; flex-wrap:wrap; gap:0.4rem; max-width: 600px;"></div>
              </div>
            </div>
            ${actionsHtml}
          </div>
        `;

        const kwContainer = document.getElementById('active-shelf-keywords');
        if (kwContainer && topic.keywords && topic.keywords.length > 0) {
          const visibleCount = 5;
          const kwArray = topic.keywords;
          const visibleKeywords = kwArray.slice(0, visibleCount);
          const hiddenKeywords = kwArray.slice(visibleCount);
          
          const renderKeywordBadges = () => {
            kwContainer.innerHTML = '';
            visibleKeywords.forEach(k => {
              const badge = document.createElement('span');
              badge.style.background = 'rgba(255,255,255,0.08)';
              badge.style.padding = '0.2rem 0.5rem';
              badge.style.borderRadius = '4px';
              badge.style.fontSize = '0.75rem';
              badge.style.color = '#ccc';
              badge.innerText = k;
              kwContainer.appendChild(badge);
            });

            if (hiddenKeywords.length > 0) {
              const moreBadge = document.createElement('span');
              moreBadge.style.background = 'rgba(96, 165, 250, 0.1)';
              moreBadge.style.color = '#60a5fa';
              moreBadge.style.padding = '0.2rem 0.5rem';
              moreBadge.style.borderRadius = '4px';
              moreBadge.style.fontSize = '0.75rem';
              moreBadge.style.cursor = 'pointer';
              moreBadge.innerText = `+${hiddenKeywords.length} more`;
              moreBadge.onclick = () => {
                kwContainer.innerHTML = '';
                kwArray.forEach(k => {
                  const badge = document.createElement('span');
                  badge.style.background = 'rgba(255,255,255,0.08)';
                  badge.style.padding = '0.2rem 0.5rem';
                  badge.style.borderRadius = '4px';
                  badge.style.fontSize = '0.75rem';
                  badge.style.color = '#ccc';
                  badge.innerText = k;
                  kwContainer.appendChild(badge);
                });
                const lessBadge = document.createElement('span');
                lessBadge.style.background = 'rgba(239, 68, 68, 0.1)';
                lessBadge.style.color = '#ef4444';
                lessBadge.style.padding = '0.2rem 0.5rem';
                lessBadge.style.borderRadius = '4px';
                lessBadge.style.fontSize = '0.75rem';
                lessBadge.style.cursor = 'pointer';
                lessBadge.innerText = 'Show less';
                lessBadge.onclick = renderKeywordBadges;
                kwContainer.appendChild(lessBadge);
              };
              kwContainer.appendChild(moreBadge);
            }
          };
          renderKeywordBadges();
        }
      }
      section.innerHTML = '';
    } else {
      section.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 1.5rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.75rem;">
          <h3 class="shelf-group-header" style="margin:0; border:none; padding:0; display:flex; align-items:center; gap:0.75rem;">
            <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
              ${topic.icon || '📌'}
            </div>
            <div style="display:flex; flex-direction:column;">
              <span style="font-size: 1.5rem; letter-spacing: -0.02em; color:#fff; text-shadow: 0 2px 10px rgba(255,255,255,0.1);">${topic.name}</span>
              <span style="font-size:0.8rem; color:var(--yt-text-muted); font-weight:500; font-family: 'Inter', sans-serif;">
                Displaying top ${displayVideos.length} of ${shelfVideos.length} trending videos sorted by ${sortCol.toUpperCase()}
              </span>
            </div>
          </h3>
          ${actionsHtml}
        </div>
      `;
    }

    if (displayVideos.length === 0) {
      section.innerHTML += `
        <div class="empty-state" style="margin-top: 1rem; padding: 3rem; background: rgba(0,0,0,0.2); border-radius: 12px;">
          <span>📭</span>
          <h3>This shelf has no videos yet</h3>
          <p>Click "Crawl Shelf" above to specifically search YouTube using your tracked keywords for this group.</p>
        </div>
      `;
      container.appendChild(section);
      await new Promise(r => requestAnimationFrame(r));
      continue;
    }

    const grid = document.createElement('div');
    grid.className = 'youtube-video-grid';

    displayVideos.forEach(video => {
      const card = document.createElement('div');
      card.className = 'yt-card';
      
      const formattedViews = formatViews(video.views);
      let perfRatio = (video.performance || 1.0).toFixed(1);
      if (video.performance >= 1000) {
        perfRatio = formatViews(Math.round(video.performance));
      }
      const formattedVph = video.vph ? formatViews(video.vph) : '0';
      const initial = (video.channel_title || 'Y').charAt(0).toUpperCase();

      const thumbSrc = video.thumbnail
        ? video.thumbnail.replace('hqdefault', 'mqdefault')
        : `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;

      // Use a consistent background color hash for the avatar fallback
      const hash = Math.abs(initial.charCodeAt(0) * 27 % 360);
      const bgColor = `hsl(${hash}, 65%, 40%)`;
      const uiAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(video.channel_title || 'Y')}&background=${hash.toString(16)}0000&color=fff&size=128&bold=true&font-size=0.4`;
      
      const finalAvatarSrc = (video.channel_avatar && video.channel_avatar.startsWith('http')) 
        ? video.channel_avatar 
        : uiAvatarUrl;

      // Calculate age in hours from published_time to detect Search Gaps vs Peak Browse
      let ageHours = 0;
      if (video.published_time) {
        const text = video.published_time.toLowerCase();
        const num = parseInt(text) || 0;
        if (text.includes('minute')) ageHours = num / 60;
        else if (text.includes('hour')) ageHours = num;
        else if (text.includes('day')) ageHours = num * 24;
        else if (text.includes('week')) ageHours = num * 168;
        else if (text.includes('month')) ageHours = num * 730;
        else if (text.includes('year')) ageHours = num * 8760;
      }

      let lifecycleBadge = '';
      if (ageHours > 0) {
        const isBoss = video.views > 500000 || video.vph > 5000;
        const browseWindow = isBoss ? 18 : 10;
        
        if (ageHours < browseWindow) {
           lifecycleBadge = `<span class="yt-tag" style="background: rgba(234, 179, 8, 0.15); color: #facc15; border-color: rgba(234, 179, 8, 0.3);" title="Browse window live — wait ~${Math.ceil(browseWindow - ageHours)}h">⚡ Peak Browse</span>`;
        } else if (ageHours < 72) {
           lifecycleBadge = ``; // Hidden per user request
        } else if (video.vph > 50) {
           lifecycleBadge = `<span class="yt-tag" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border-color: rgba(59, 130, 246, 0.3);" title="Old content still pulling views">💎 Evergreen Hit</span>`;
        } else {
           lifecycleBadge = `<span class="yt-tag" style="background: rgba(156, 163, 175, 0.15); color: #9ca3af; border-color: rgba(156, 163, 175, 0.3);" title="Old content — demand may have moved on">❄️ Aging</span>`;
        }
      }

      card.innerHTML = `
        <div class="yt-thumbnail-wrapper" style="position: relative; overflow: hidden; border-radius: 14px; border: 1px solid rgba(255,255,255,0.05);">
          <img
            class="yt-card-img"
            src="${thumbSrc}"
            alt="${video.title}"
            style="width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);"
          >
          ${video.duration ? `<span class="yt-duration">${video.duration}</span>` : ''}
        </div>
        <div class="yt-card-details">
          <div class="yt-avatar" style="background: ${bgColor}; padding: 0; overflow: hidden; border: 1px solid rgba(255,255,255,0.1);">
            <img src="${finalAvatarSrc}" alt="${initial}" style="width:100%; height:100%; object-fit:cover;" class="yt-avatar-img">
          </div>
          <div class="yt-meta">
            <div class="yt-title" title="${video.title}">${video.title}</div>
            <div class="yt-channel">
              ${video.channel_title || 'Unknown Channel'}
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#aaa;flex-shrink:0;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
            </div>
            <div class="yt-stats-row">
              <span>${formattedViews} views</span>
              <span>•</span>
              <span>${getRelativeTimeHtml(video)}</span>
            </div>
            <div style="display:flex; gap:0.4rem; flex-wrap:wrap; margin-top:0.6rem; align-items: center;">
              <span class="yt-tag red">⚡ ${formattedVph} VPH</span>
              <span class="yt-tag blue">🔥 ${perfRatio}x Perf</span>
              <span class="yt-tag green">📈 +${video.current_vph || video.change_30m || 0} /vph</span>
              ${lifecycleBadge}
              ${selectedTopicFilter === null && video.topic_id ? `<span class="yt-tag" style="background: rgba(255, 255, 255, 0.08); color: #fff; border-color: rgba(255, 255, 255, 0.2); font-weight: 600; font-size: 0.75rem; padding: 0.25rem 0.5rem; display: flex; align-items: center; gap: 6px; cursor: help;" title="Source Group">📁 ${allTopics.find(t => t.id === video.topic_id)?.name || 'Unknown'}</span>` : ''}
              ${video.keyword ? `<span class="yt-tag" style="background: rgba(147, 51, 234, 0.15); color: #c084fc; border-color: rgba(147, 51, 234, 0.3); font-weight: 600; font-size: 0.75rem; padding: 0.25rem 0.5rem; display: flex; align-items: center; gap: 6px; cursor: help;" title="Source Keyword: ${video.keyword}\n\nWhy: This video is trending under your tracked keyword.\nHow: PulseTube's background crawler continuously scans YouTube search results to discover emerging content before it hits the browse algorithm.">● ${video.keyword}</span>` : ''}
            </div>

          </div>
        </div>
      `;

      // Fallback for missing/blocked high-res thumbnails (with strict prevention of infinite loops)
      const img = card.querySelector('.yt-card-img');
      if (img) {
        img.addEventListener('error', function fallback() {
          img.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
        }, { once: true });
      }

      // Fallback for missing avatars
      const avatarImg = card.querySelector('.yt-avatar-img');
      if (avatarImg) {
        avatarImg.addEventListener('error', function fallbackAvatar() {
          this.src = uiAvatarUrl;
          this.addEventListener('error', function() {
            this.style.display = 'none';
            this.parentNode.innerHTML = initial;
          }, { once: true });
        }, { once: true });
      }

      // Add thumbnail zoom hover interaction
      card.addEventListener('mouseenter', () => {
        if (img) img.style.transform = 'scale(1.04)';
      });
      card.addEventListener('mouseleave', () => {
        if (img) img.style.transform = 'scale(1)';
      });

      // Navigate to full dual column watch view
      card.addEventListener('click', () => openVideoWatchTheater(video, shelfVideos));

      grid.appendChild(card);
    });

    section.appendChild(grid);
    container.appendChild(section);
    
    // Yield to browser UI thread to prevent lag
    await new Promise(r => setTimeout(r, 0));
  }

  if (totalRendered === 0) {
    const hasSearch = document.getElementById('search-bar').value.trim().length > 0;
    container.innerHTML = `
      <div class="empty-state">
        <span>${hasSearch ? '🔍' : '📭'}</span>
        <h3>${hasSearch ? 'No results match your search' : 'This shelf has no videos yet'}</h3>
        <p>${hasSearch
          ? 'Try a different keyword or clear the search bar.'
          : 'Run a crawl to populate this category with fresh YouTube videos.'
        }</p>
        ${!hasSearch ? `<button id="btn-shelf-crawl" class="btn" style="margin-top:1.25rem; background:linear-gradient(135deg,#ff0000,#cc0000); border:none; color:#fff; padding:0.7rem 1.5rem; border-radius:25px; font-size:0.95rem; font-weight:700; cursor:pointer;">🚀 Run Crawl Now</button>` : ''}
      </div>
    `;
    document.getElementById('btn-shelf-crawl')?.addEventListener('click', triggerManualCrawl);
  }
}

// ─── COMPETITOR INTEL GRID ───
function renderCigGrid() {
  const tbody = document.getElementById('cig-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  // Flatten all unique videos across all shelves
  const uniqueMap = new Map();
  allVideos.forEach(v => {
    if (!uniqueMap.has(v.id)) uniqueMap.set(v.id, v);
    else if ((parseFloat(v.vph) || 0) > (parseFloat(uniqueMap.get(v.id).vph) || 0)) {
      uniqueMap.set(v.id, v); // keep the highest velocity one
    }
  });
  
  const allVideosFlat = Array.from(uniqueMap.values());
  // Sort strictly by VPH
  allVideosFlat.sort((a, b) => (parseFloat(b.vph) || 0) - (parseFloat(a.vph) || 0));
  
  // Cap at top 100 competitors
  const top100 = allVideosFlat.slice(0, 100);
  
  if (top100.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 2rem;">No data available. Run a crawl first.</td></tr>`;
    return;
  }
  
  top100.forEach(video => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
    
    const formattedVph = video.vph ? formatViews(video.vph) : '0';
    let perfRatio = (video.performance || 1.0).toFixed(1);
    
    // Recalculate lifecycle badge
    let ageHours = 0;
    let lifecycleBadge = '';
    if (video.published_time) {
      const text = video.published_time.toLowerCase();
      const num = parseInt(text) || 0;
      if (text.includes('minute')) ageHours = num / 60;
      else if (text.includes('hour')) ageHours = num;
      else if (text.includes('day')) ageHours = num * 24;
      else if (text.includes('week')) ageHours = num * 168;
      else if (text.includes('month')) ageHours = num * 730;
      else if (text.includes('year')) ageHours = num * 8760;
    }
    if (ageHours > 0) {
      const isBoss = video.views > 500000 || video.vph > 5000;
      const browseWindow = isBoss ? 18 : 10;
      if (ageHours < browseWindow) lifecycleBadge = `<span style="color:#facc15">⚡ Peak Browse</span>`;
      else if (ageHours < 72) lifecycleBadge = `<span style="color:#34d399">🔥 Prime Opp</span>`;
      else if (video.vph > 50) lifecycleBadge = `<span style="color:#60a5fa">💎 Evergreen</span>`;
      else lifecycleBadge = `<span style="color:#9ca3af">❄️ Aging</span>`;
    }

    const titleAnchor = `<a href="#" style="color:#fff; text-decoration:none; display:block; max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${video.title}">${video.title}</a>`;
    
    const avatarUrl = (video.channel_avatar && video.channel_avatar.startsWith('http')) ? video.channel_avatar : `https://ui-avatars.com/api/?name=${encodeURIComponent(video.channel_title || 'Y')}&background=random&color=fff&size=32`;

    tr.innerHTML = `
      <td style="padding: 1rem; color: #fff; font-weight: 600;">
        <div style="display:flex; align-items:center; gap: 0.5rem;">
          <img src="${avatarUrl}" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;">
          <span style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${video.channel_title}">${video.channel_title || 'Unknown'}</span>
        </div>
      </td>
      <td style="padding: 1rem;">
        ${titleAnchor}
        <div style="font-size: 0.75rem; color: #c084fc; margin-top: 0.2rem; display:flex; align-items:center; gap: 6px; cursor: help;" title="Source Keyword: ${video.keyword || 'Unknown'}\n\nWhy: This video is trending under your tracked keyword.\nHow: PulseTube's background crawler continuously scans YouTube search results to discover emerging content before it hits the browse algorithm.">● ${video.keyword || 'Unknown keyword'}</div>
      </td>
      <td style="padding: 1rem; color: #f87171; font-weight: bold;">${formattedVph}</td>
      <td style="padding: 1rem; color: #60a5fa; font-weight: bold;">${perfRatio}x</td>
      <td style="padding: 1rem; font-size: 0.85rem; font-weight: 600;">${lifecycleBadge}</td>
    `;
    
    const a = tr.querySelector('a');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openVideoWatchTheater(video, allVideosFlat);
    });
    
    tbody.appendChild(tr);
  });
}

// ─── WATCH THEATER CONTROLLER ───

// Opens the video in a real YouTube tab and injects a floating Pulse metrics panel
function openVideoWatchTheater(video, relatedList = []) {
  const ytUrl = `https://www.youtube.com/watch?v=${video.id}`;

  // Build overlay metrics payload to send to the injected tab
  const metricsPayload = {
    id: video.id,
    title: video.title,
    channel: video.channel_title || 'Unknown Channel',
    views: formatViews(video.views || 0),
    published: video.published_time || '',
    perf: (video.performance || 1.0).toFixed(2),
    vph: formatViews(video.vph || 0),
    growth: formatViews(video.current_vph || video.change_30m || 0),
    recs: (relatedList || []).filter(r => r.id !== video.id).slice(0, 8).map(r => ({
      id: r.id,
      title: r.title,
      channel: r.channel_title || '',
      views: formatViews(r.views || 0),
      thumb: r.thumbnail || `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`
    }))
  };

  // Open YouTube tab without injecting the floating panel
  chrome.tabs.create({ url: ytUrl, active: true });
}

// ─── PULSE PANEL INJECTOR (runs inside youtube.com tab) ───
// This function is serialized and sent via chrome.scripting.executeScript
function injectPulsePanel(metrics) {
  // Avoid double-injection
  if (document.getElementById('pulsetube-panel')) return;

  const formatNum = (n) => {
    const v = parseFloat(n) || 0;
    if (v >= 1e9) return (v/1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v/1e3).toFixed(1) + 'K';
    return String(v);
  };

  const recsHtml = (metrics.recs || []).map(r => `
    <a href="https://www.youtube.com/watch?v=${r.id}" style="display:flex;gap:10px;cursor:pointer;padding:8px;border-radius:8px;text-decoration:none;transition:background 0.2s;" class="pulse-suggestion-item" data-id="${r.id}">
      <img src="${r.thumb}" style="width:100px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0;" class="rec-thumb-img">
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:#fff;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${r.title}</div>
        <div style="font-size:11px;color:#aaa;margin-top:3px;">${r.channel}</div>
        <div style="font-size:11px;color:#aaa;">${r.views} views</div>
      </div>
    </a>
  `).join('');

  const panel = document.createElement('div');
  panel.id = 'pulsetube-panel';
  panel.style.cssText = `
    position: fixed;
    top: 60px;
    right: 16px;
    width: 300px;
    max-height: calc(100vh - 80px);
    background: rgba(15,15,15,0.96);
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 16px;
    z-index: 9999;
    color: #fff;
    font-family: -apple-system, 'YouTube Sans', Roboto, sans-serif;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 40px rgba(0,0,0,0.7);
    transition: transform 0.3s ease;
  `;

  panel.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:26px;height:26px;background:linear-gradient(135deg,#ff0000,#cc0000);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;">⚡</div>
        <span style="font-weight:700;font-size:14px;color:#fff;">PulseTube Metrics</span>
      </div>
      <button id="pt-close" style="background:rgba(255,255,255,0.1);border:none;color:#fff;width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">✕</button>
    </div>

    <!-- Metrics Grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px;flex-shrink:0;">
      <div style="background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.2);padding:10px;border-radius:10px;text-align:center;">
        <div style="font-size:10px;color:#ff6b6b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">🔥 Performance</div>
        <div style="font-size:18px;font-weight:800;margin-top:4px;">${metrics.perf}x</div>
      </div>
      <div style="background:rgba(80,140,255,0.12);border:1px solid rgba(80,140,255,0.2);padding:10px;border-radius:10px;text-align:center;">
        <div style="font-size:10px;color:#7eb3ff;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">⚡ Velocity</div>
        <div style="font-size:18px;font-weight:800;margin-top:4px;">${metrics.vph}/h</div>
      </div>
      <div style="background:rgba(80,200,100,0.12);border:1px solid rgba(80,200,100,0.2);padding:10px;border-radius:10px;text-align:center;">
        <div style="font-size:10px;color:#6dde88;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">📈 Current VPH</div>
        <div style="font-size:18px;font-weight:800;margin-top:4px;">+${metrics.growth}</div>
      </div>
      <div style="background:rgba(200,150,255,0.12);border:1px solid rgba(200,150,255,0.2);padding:10px;border-radius:10px;text-align:center;">
        <div style="font-size:10px;color:#c9a0ff;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">👁️ Total Views</div>
        <div style="font-size:18px;font-weight:800;margin-top:4px;">${metrics.views}</div>
      </div>
    </div>

    <!-- Related Videos -->
    ${recsHtml.length > 0 ? `
    <div style="border-top:1px solid rgba(255,255,255,0.08);flex-shrink:0;padding:8px 14px 4px;">
      <div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;">🎯 More from Pulse</div>
    </div>
    <div style="overflow-y:auto;padding:4px 6px 10px;flex:1;">${recsHtml}</div>
    ` : ''}
  `;

  document.body.appendChild(panel);

  document.getElementById('pt-close').addEventListener('click', () => panel.remove());

  // Attach error handlers for recommendation images
  panel.querySelectorAll('.pulse-suggestion-item').forEach(item => {
    const img = item.querySelector('.rec-thumb-img');
    const videoId = item.getAttribute('data-id');
    if (img && videoId) {
      img.addEventListener('error', function() {
        this.src = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';
      }, { once: true });
    }
  });

  // Make panel draggable
  let dragging = false, ox = 0, oy = 0;
  const header = panel.querySelector('div');
  header.style.cursor = 'grab';
  header.addEventListener('mousedown', e => {
    dragging = true;
    ox = e.clientX - panel.getBoundingClientRect().left;
    oy = e.clientY - panel.getBoundingClientRect().top;
    header.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.left = (e.clientX - ox) + 'px';
    panel.style.top = (e.clientY - oy) + 'px';
    panel.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; header.style.cursor = 'grab'; });
}

// Views helper
function formatViews(num) {
  if (num === null || num === undefined) return '0';
  const val = parseFloat(num);
  if (val >= 1000000000) {
    return (val / 1000000000).toFixed(2).replace(/\.00$/, '') + 'B';
  }
  if (val >= 1000000) {
    return (val / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
  }
  if (val >= 1000) {
    return (val / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return val.toString();
}

// Event handlers
function setupEventListeners() {
  const modal = document.getElementById('group-modal');
  
  // Modal open
  document.getElementById('btn-add-group').addEventListener('click', () => {
    document.getElementById('modal-title').innerText = 'Create Keyword Group';
    document.getElementById('modal-group-id').value = '';
    document.getElementById('modal-group-icon').value = '📌';
    document.getElementById('modal-group-name').value = '';
    document.getElementById('modal-group-keywords').value = '';
    document.getElementById('modal-group-enabled').checked = true;
    const container = document.getElementById('modal-tag-container');
    if(container) {
      const tags = container.querySelectorAll('.modal-tag');
      tags.forEach(t => t.remove());
    }
    modal.classList.add('active');
  });

  document.getElementById('btn-close-modal').addEventListener('click', () => modal.classList.remove('active'));
  document.getElementById('btn-cancel-modal').addEventListener('click', () => modal.classList.remove('active'));

  document.getElementById('btn-manual-crawl')?.addEventListener('click', triggerManualCrawl);
  document.getElementById('btn-empty-crawl')?.addEventListener('click', triggerManualCrawl);

  // Manual Sync Refresh
  const syncBtn = document.getElementById('btn-pull-github');
  if (syncBtn) {
    let isSyncing = false;
    syncBtn.addEventListener('click', async () => {
      if (isSyncing) return;
      isSyncing = true;
      syncBtn.style.opacity = '0.5';
      syncBtn.innerText = '🔄 Pulling...';
      const statusEl = document.getElementById('header-crawl-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:#aaa;">Syncing from GitHub DB...</span>';
      
      // Force reload both configs and data from GitHub
      await loadTopics();
      await loadDashboardFeed();
      updateCrawlStatus();
      
      syncBtn.style.opacity = '1';
      syncBtn.innerText = '🔄 Pull DB';
      setTimeout(() => { isSyncing = false; }, 2000); // 2 second throttle
    });
  }
  document.getElementById('btn-crawl-all-home')?.addEventListener('click', triggerManualCrawl);

  // Delegate shelf actions (Edit, Crawl) from dynamically created headers
  document.getElementById('active-shelf-header')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.shelf-action-btn');
    if (btn) {
      const action = btn.getAttribute('data-action');
      const topicId = btn.getAttribute('data-topic');
      if (action === 'edit') {
        openEditModalFromFeed(topicId);
      } else if (action === 'crawl') {
        crawlGroup(topicId);
      }
    }
  });

  // Search trigger
  document.getElementById('search-bar').addEventListener('input', () => {
    selectedTopicFilter = null; // search filters across all rows
    switchView('home');
  });
  
  document.getElementById('search-btn').addEventListener('click', () => {
    selectedTopicFilter = null;
    switchView('home');
  });

  // Save Group
  document.getElementById('btn-save-group').addEventListener('click', async () => {
    try {
      const id = document.getElementById('modal-group-id').value;
      const icon = document.getElementById('modal-group-icon').value.trim();
      const name = document.getElementById('modal-group-name').value.trim();
      const enabled = document.getElementById('modal-group-enabled').checked;
      
      // Force any remaining typed text into a pill before saving
      const input = document.getElementById('modal-tag-input');
      if (input && input.value.trim()) {
        const val = input.value.trim();
        const container = document.getElementById('modal-tag-container');
        if (container) {
          container.insertBefore(createTagPill(val), input);
        }
        input.value = '';
      }
      
      // Update hidden textarea just in case
      syncTagsToTextarea();
      const kwText = document.getElementById('modal-group-keywords').value.trim();

      if (!name) {
        alert('Group name is required.');
        return;
      }

      const keywords = kwText ? kwText.split(',').map(k => k.trim()).filter(Boolean) : [];
      const result = await storage.get(`${STORAGE_PREFIX}topics`);
      let topics = result[`${STORAGE_PREFIX}topics`] || [];

      if (id) {
        // Edit
        topics = topics.map(t => {
          if (t.id === id) {
            t.icon = icon;
            t.name = name;
            t.keywords = keywords;
            t.enabled = enabled;
          }
          return t;
        });
      } else {
        // Create - using manual generator to completely avoid crypto API edge cases
        const newTopic = {
          id: 'grp_' + Date.now().toString(36) + Math.random().toString(36).substring(2),
          icon,
          name,
          keywords,
          position: topics.length,
          enabled: enabled
        };
        topics.push(newTopic);
      }

      await storage.set({ [`${STORAGE_PREFIX}topics`]: topics });
      document.getElementById('group-modal').classList.remove('active');
      
      // Update locally without fetching from server first to prevent overwriting
      await loadTopics(true);
      
      const autoSync = document.getElementById('sync-gh-auto')?.checked ?? true;
      if (autoSync) {
        syncTopicsToGitHub(topics);
      }
    } catch (error) {
      console.error("Save Group Error:", error);
      alert("Error saving group: " + error.message + "\nLine: " + error.lineNumber);
    }
  });



  // Export Groups
  document.getElementById('btn-export-groups').addEventListener('click', async () => {
    const result = await storage.get(`${STORAGE_PREFIX}topics`);
    const topics = result[`${STORAGE_PREFIX}topics`] || [];
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(topics, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "pulsetube_topics_export.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  });
  // Delete All Groups
  document.getElementById('btn-delete-all-groups').addEventListener('click', async () => {
    if (confirm("Are you sure you want to delete ALL keyword groups? This cannot be undone!")) {
      await storage.set({ [`${STORAGE_PREFIX}topics`]: [] });
      await syncTopicsToGitHub([]); // Wipe GitHub first
      await loadTopics(true); // Clear UI immediately
      alert("All groups have been deleted.");
    }
  });

  // Import Groups
  document.getElementById('btn-import-groups').addEventListener('click', () => {
    document.getElementById('file-import-groups').click();
  });

  document.getElementById('file-import-groups').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const importedTopics = JSON.parse(event.target.result);
        if (Array.isArray(importedTopics)) {
          if (confirm('Do you want to intelligently MERGE these imported groups with your existing ones? (Keeps your custom groups and adds new keywords)')) {
            const currentResult = await storage.get(`${STORAGE_PREFIX}topics`);
            let existingTopics = currentResult[`${STORAGE_PREFIX}topics`] || [];
            
            importedTopics.forEach(impTopic => {
              const existingIdx = existingTopics.findIndex(t => t.id === impTopic.id || t.name === impTopic.name);
              if (existingIdx >= 0) {
                // Merge keywords
                const combinedKeywords = new Set([...(existingTopics[existingIdx].keywords || []), ...(impTopic.keywords || [])]);
                existingTopics[existingIdx].keywords = Array.from(combinedKeywords);
              } else {
                // Add new group
                existingTopics.push(impTopic);
              }
            });
            
            await storage.set({ [`${STORAGE_PREFIX}topics`]: existingTopics });
            await loadTopics(true);
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
              chrome.runtime.sendMessage({ action: 'sync_topics' }, () => {});
            }
            alert('Groups merged successfully!');
          }
        } else {
          alert('Invalid JSON format for imported groups.');
        }
      } catch (err) {
        alert('Failed to parse JSON file.');
      }
      e.target.value = ''; // Reset input
    };
    reader.readAsText(file);
  });

  // Restore Defaults
  document.getElementById('btn-restore-defaults').addEventListener('click', () => {
    if (confirm('Are you sure you want to wipe all current keyword groups and restore the new factory defaults?')) {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: 'restore_defaults' }, async () => {
          await loadTopics(true);
          alert('Factory Defaults Restored!');
        });
      } else {
        alert('Cannot restore defaults in web preview mode.');
      }
    }
  });

  // Save GitHub credentials (Manual Button)
  document.getElementById('btn-save-credentials').addEventListener('click', async () => {
    const repo = document.getElementById('gh-repo') ? document.getElementById('gh-repo').value.trim() : 'shrik7891-pixel/pulsetube-next';
    const ghToken = document.getElementById('gh-token') ? document.getElementById('gh-token').value.trim() : '';

    await storage.set({
      [`${STORAGE_PREFIX}github_repo`]: repo,
      [`${STORAGE_PREFIX}github_token`]: ghToken
    });
    alert('Credentials saved! The extension will now sync topics to the cloud and fetch live analytics.');
  });
  
  // REAL-TIME AUTO-SAVE for GitHub inputs so user never has to click save
  const ghTokenInput = document.getElementById('gh-token');
  if (ghTokenInput) {
    ghTokenInput.addEventListener('input', async (e) => {
      const val = e.target.value.trim();
      if (val.startsWith('ghp_') || val.startsWith('github_pat_')) {
        await storage.set({ [`${STORAGE_PREFIX}github_token`]: val });
      }
    });
  }
  
  const ghRepoInput = document.getElementById('gh-repo');
  if (ghRepoInput) {
    ghRepoInput.addEventListener('input', async (e) => {
      await storage.set({ [`${STORAGE_PREFIX}github_repo`]: e.target.value.trim() });
    });
  }

  let cloudSyncPollInterval = null;

  async function startCloudSyncLogPolling(ghToken) {
    const res = await storage.get(`${STORAGE_PREFIX}github_repo`);
    const repo = res[`${STORAGE_PREFIX}github_repo`] || 'shrik7891-pixel/pulsetube-next';
    const container = document.getElementById('cloud-sync-logs-container');
    const terminal = document.getElementById('cloud-sync-terminal');
    const statusEl = document.getElementById('cloud-sync-status');
    
    if (!container || !terminal) return;
    
    container.style.display = 'flex';
    terminal.innerHTML = '<div style="color: #34d399">> Workflow dispatched successfully.</div><div>> Waiting for runner allocation...</div>';
    statusEl.innerText = 'Initializing...';
    
    if (cloudSyncPollInterval) clearInterval(cloudSyncPollInterval);
    
    // Wait a couple seconds before first poll so GitHub registers the run
    setTimeout(() => {
      cloudSyncPollInterval = setInterval(async () => {
        try {
          const headers = { 'Accept': 'application/vnd.github+json' };
          if (ghToken) headers['Authorization'] = `Bearer ${ghToken.trim()}`;
          const cleanRepo = repo.trim();

          // Fetch runs
          let runsRes;
          try {
            runsRes = await fetch(`https://api.github.com/repos/${cleanRepo}/actions/runs?status=in_progress`, { headers });
          } catch (fetchErr) {
            console.error("Network error fetching runs:", fetchErr);
            terminal.innerHTML += `<div style="color: #ef4444">> Error connecting to GitHub API. Check connection.</div>`;
            return;
          }
          
          if (!runsRes.ok) {
            console.error("GitHub API error:", runsRes.status, await runsRes.text());
            return;
          }

          const runsData = await runsRes.json();
          const activeRun = runsData.workflow_runs && runsData.workflow_runs.length > 0 ? runsData.workflow_runs[0] : null;
          
          const stopBtn = document.getElementById('btn-stop-gh-action-home');
          if (!activeRun) {
            if (stopBtn) stopBtn.style.display = 'none';
            // Check if it recently completed
            const allRunsRes = await fetch(`https://api.github.com/repos/${cleanRepo}/actions/runs?per_page=1`, { headers });
            if (allRunsRes.ok) {
              const allRunsData = await allRunsRes.json();
              const latestRun = allRunsData.workflow_runs?.[0];
              
              if (latestRun && latestRun.status === 'completed') {
                const timeSinceEnd = Date.now() - new Date(latestRun.updated_at).getTime();
                if (timeSinceEnd < 90000) { // Completed in the last 1.5 minutes
                  clearInterval(cloudSyncPollInterval);
                  terminal.innerHTML += `<div style="color: #34d399">> ✅ Crawler completed successfully!</div>`;
                  statusEl.innerText = 'Completed';
                  setTimeout(async () => {
                    container.style.display = 'none';
                    await loadTopics();
                    await loadDashboardFeed();
                    updateCrawlStatus();
                  }, 5000);
                }
              }
            }
            return;
          }
          
          if (stopBtn) stopBtn.style.display = 'flex';
          
          if (!activeRun.jobs_url) return;

          let jobsRes;
          try {
            jobsRes = await fetch(activeRun.jobs_url, { headers });
          } catch (fetchErr) {
             console.error("Network error fetching jobs:", fetchErr);
             return;
          }

          if (!jobsRes.ok) return;

          const jobsData = await jobsRes.json();
          const job = jobsData.jobs && jobsData.jobs.length > 0 ? jobsData.jobs[0] : null;
          
          if (job) {
            const mins = Math.floor((Date.now() - new Date(job.started_at).getTime()) / 60000);
            const secs = Math.floor(((Date.now() - new Date(job.started_at).getTime()) % 60000) / 1000);
            statusEl.innerText = `Running - ${mins}m ${secs}s`;
            
            let terminalHtml = '';
            job.steps.forEach(step => {
              if (step.status === 'completed') {
                terminalHtml += `<div style="color: #64748b">> [DONE] ${step.name}</div>`;
              } else if (step.status === 'in_progress') {
                terminalHtml += `<div style="color: #60a5fa">> [RUNNING] ${step.name}... <span style="animation: pulse 1s infinite">_</span></div>`;
              }
            });
            terminal.innerHTML = terminalHtml;
            terminal.scrollTop = terminal.scrollHeight;
          }
        } catch (e) {
          console.error("Log fetch error:", e);
        }
      }, 5000);
    }, 4000);
  }

  async function triggerGitHubAction(btn, workflow = 'crawl.yml') {
    const originalText = btn.innerHTML;
    btn.innerHTML = "⏳ Triggering...";
    btn.disabled = true;

    const res = await storage.get([`${STORAGE_PREFIX}github_token`, `${STORAGE_PREFIX}github_repo`]);
    let ghToken = res[`${STORAGE_PREFIX}github_token`] || (document.getElementById('gh-token') ? document.getElementById('gh-token').value.trim() : '');
    const repo = res[`${STORAGE_PREFIX}github_repo`] || (document.getElementById('gh-repo') ? document.getElementById('gh-repo').value.trim() : 'shrik7891-pixel/pulsetube-next');
    
    if (!ghToken) {
      alert("Please go to Local DB Config and enter your GitHub Personal Access Token first.");
      btn.innerHTML = originalText;
      btn.disabled = false;
      return;
    }
    
    // Auto-correct CLI token
    if (ghToken.startsWith('gho_')) {
      ghToken = document.getElementById('gh-token') ? document.getElementById('gh-token').value.trim() : '';
    }
    
    // Always auto-save the token and repo when triggering so the background script has it for alarms
    if (ghToken.startsWith('ghp_') || ghToken.startsWith('github_pat_')) {
      await storage.set({ 
        [`${STORAGE_PREFIX}github_token`]: ghToken,
        [`${STORAGE_PREFIX}github_repo`]: repo
      });
    }

    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${ghToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref: 'main' })
      });

      if (response.ok) {
        btn.innerHTML = "✅ Triggered!";
        startCloudSyncLogPolling(ghToken);
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.disabled = false;
        }, 3000);
      } else {
        console.error("GitHub Action Error:", await response.text());
        btn.innerHTML = "❌ Failed (See Console)";
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.disabled = false;
        }, 3000);
      }
    } catch (e) {
      console.error("GitHub Action Exception:", e);
      btn.innerHTML = "❌ Network Error";
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }, 3000);
    }
  }

  const fastDeployBtn = document.getElementById('btn-fast-tv-deploy');

  if (fastDeployBtn) {
    fastDeployBtn.addEventListener('click', async () => {
      const result = await storage.get(`${STORAGE_PREFIX}topics`);
      const topics = result[`${STORAGE_PREFIX}topics`] || [];
      // First, sync any local topic changes to GitHub to ensure they are available
      await syncTopicsToGitHub(topics, true);
      triggerGitHubAction(fastDeployBtn, 'tv_sync.yml');
    });
  }
  const ghBtn = document.getElementById('btn-trigger-gh-action');
  if (ghBtn) ghBtn.addEventListener('click', () => triggerGitHubAction(ghBtn));
  
  const ghHomeBtn = document.getElementById('btn-trigger-gh-action-home');
  if (ghHomeBtn) ghHomeBtn.addEventListener('click', () => triggerGitHubAction(ghHomeBtn));

  async function stopGitHubAction() {
    const btn = document.getElementById('btn-stop-gh-action-home');
    if (!btn) return;
    
    const originalText = btn.innerHTML;
    btn.innerHTML = "⏳ Stopping...";
    btn.disabled = true;

    const res = await storage.get([`${STORAGE_PREFIX}github_token`, `${STORAGE_PREFIX}github_repo`]);
    let ghToken = res[`${STORAGE_PREFIX}github_token`] || (document.getElementById('gh-token') ? document.getElementById('gh-token').value.trim() : '');
    const repo = res[`${STORAGE_PREFIX}github_repo`] || 'shrik7891-pixel/pulsetube-next';
    
    if (!ghToken) {
      alert("No GitHub token found.");
      btn.innerHTML = originalText;
      btn.disabled = false;
      return;
    }

    try {
      const runsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?status=in_progress`, {
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github+json' }
      });
      if (runsRes.ok) {
        const runsData = await runsRes.json();
        if (runsData.workflow_runs && runsData.workflow_runs.length > 0) {
          const runId = runsData.workflow_runs[0].id;
          const cancelRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/cancel`, {
            method: 'POST',
            headers: {
              'Accept': 'application/vnd.github+json',
              'Authorization': `Bearer ${ghToken}`,
              'X-GitHub-Api-Version': '2022-11-28'
            }
          });
          
          if (cancelRes.ok || cancelRes.status === 202) {
            btn.innerHTML = "✅ Stopped!";
            setTimeout(() => {
              btn.innerHTML = originalText;
              btn.disabled = false;
              btn.style.display = 'none'; // hide it after stopping
              const container = document.getElementById('cloud-sync-logs-container');
              if (container) container.style.display = 'none';
              if (cloudSyncPollInterval) clearInterval(cloudSyncPollInterval);
            }, 3000);
          } else {
            btn.innerHTML = "❌ Failed";
            setTimeout(() => {
              btn.innerHTML = originalText;
              btn.disabled = false;
            }, 3000);
          }
        } else {
          btn.innerHTML = "✅ No active runs";
          setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
            btn.style.display = 'none';
            const container = document.getElementById('cloud-sync-logs-container');
            if (container) container.style.display = 'none';
            if (cloudSyncPollInterval) clearInterval(cloudSyncPollInterval);
          }, 3000);
        }
      }
    } catch(e) {
      btn.innerHTML = "❌ Error";
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }, 3000);
    }
  }

  const stopGhHomeBtn = document.getElementById('btn-stop-gh-action-home');
  if (stopGhHomeBtn) stopGhHomeBtn.addEventListener('click', stopGitHubAction);

  async function checkActiveCloudSync() {
    const res = await storage.get([`${STORAGE_PREFIX}github_token`, `${STORAGE_PREFIX}github_repo`]);
    let ghToken = res[`${STORAGE_PREFIX}github_token`] || (document.getElementById('gh-token') ? document.getElementById('gh-token').value.trim() : '');
    const repo = res[`${STORAGE_PREFIX}github_repo`] || 'shrik7891-pixel/pulsetube-next';
    if (!ghToken || ghToken.startsWith('gho_')) return;
    
    try {
      const runsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?status=in_progress`, {
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github+json' }
      });
      if (runsRes.ok) {
        const runsData = await runsRes.json();
        if (runsData.workflow_runs && runsData.workflow_runs.length > 0) {
          startCloudSyncLogPolling(ghToken);
        }
      }
    } catch(e) {}
  }
  window.checkActiveCloudSync = checkActiveCloudSync;

  // Settings: Auto-Scan
  const autoScanEl = document.getElementById('auto-scan-interval');
  if (autoScanEl) {
    storage.get(`${STORAGE_PREFIX}autoscan_interval`).then(res => {
      autoScanEl.value = res[`${STORAGE_PREFIX}autoscan_interval`] || '0';
    });
    autoScanEl.addEventListener('change', async (e) => {
      const minutes = parseInt(e.target.value, 10);
      await storage.set({ [`${STORAGE_PREFIX}autoscan_interval`]: minutes });
      if (minutes === 0) {
        await chrome.alarms.clear('pulse_crawl_alarm');
        alert('Auto-scan disabled. You must run manual crawls now.');
      } else {
        await chrome.alarms.create('pulse_crawl_alarm', { periodInMinutes: minutes });
        alert(`Auto-scan set to every ${minutes} minutes.`);
      }
    });
  }

  // Auto-resume GitHub logs if a run is already active
  checkActiveCloudSync();

  // Settings: TV Sync
  const tvSyncEl = document.getElementById('tv-sync-enabled');
  if (tvSyncEl) {
    tvSyncEl.addEventListener('change', async (e) => {
      const enabled = e.target.value === "true";
      await storage.set({ [`${STORAGE_PREFIX}tv_sync_enabled`]: enabled });
      alert(enabled ? 'Cloud sync enabled. Your next crawl will appear on Android TV.' : 'Cloud sync disabled. Private mode active.');
    });
  }

  // Settings: Cloud Sync Minute
  const saveMinuteBtn = document.getElementById('btn-save-sync-minute');
  if (saveMinuteBtn) {
    saveMinuteBtn.addEventListener('click', async () => {
      const minute = parseInt(document.getElementById('cloud-sync-minute').value, 10);
      if (minute < 0 || minute > 59 || isNaN(minute)) {
        alert('Please enter a valid minute between 0 and 59.');
        return;
      }
      await storage.set({ [`${STORAGE_PREFIX}cloud_sync_minute`]: minute });
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: 'update_cloud_sync_minute', minute }, () => {
          updateCrawlStatus();
        });
      } else {
        updateCrawlStatus();
      }
      alert(`Cloud sync will now trigger exactly at minute ${minute} of every hour.`);
    });
  }

  // Sidebar manual crawl trigger
  document.getElementById('side-trigger-crawl').addEventListener('click', triggerManualCrawl);
}

function triggerManualCrawl() {
  const btn = document.getElementById('side-trigger-crawl');
  if (btn) {
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';
  }
  
  const btnEmpty = document.getElementById('btn-empty-crawl');
  if (btnEmpty) {
    btnEmpty.style.opacity = '0.5';
    btnEmpty.style.pointerEvents = 'none';
    btnEmpty.innerText = 'Crawling YouTube...';
  }
  
  const btnHome = document.getElementById('btn-crawl-all-home');
  if (btnHome) {
    btnHome.style.opacity = '0.5';
    btnHome.style.pointerEvents = 'none';
    btnHome.innerHTML = '⏳ Crawling...';
  }
  
  const statusEl = document.getElementById('header-crawl-status');
  if (statusEl) {
    statusEl.innerText = 'Crawling YouTube...';
  }

  runtime.sendMessage({ action: 'run_manual_crawl' }, (response) => {
    if (response === undefined && chrome.runtime.lastError) {
      console.warn('Crawl is taking a long time. Message channel closed, relying on progress events.');
      return;
    }
    
    if (btn) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }
    if (btnEmpty) {
      btnEmpty.style.opacity = '1';
      btnEmpty.style.pointerEvents = 'auto';
      btnEmpty.innerText = '🚀 Run Your First Crawl';
    }

    if (response?.success) {
      if (statusEl) statusEl.innerText = 'Crawl Finished';

      // Auto-navigate to Home Feed view so user immediately sees their data populate!
      selectedTopicFilter = null;
      switchView('home');
      document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
      const sideHome = document.getElementById('side-home');
      if (sideHome) sideHome.classList.add('active');
      
      updateCrawlStatus();
      loadDashboardFeed();
    } else {
      if (statusEl) statusEl.innerText = 'Crawl Error';
      alert('Crawl failed: ' + (response?.error || 'Unknown error occurred. Ensure you are signed in.'));
      updateCrawlStatus();
    }
  });
}

window.openEditModalFromFeed = (topicId) => {
  const t = allTopics.find(x => x.id === topicId);
  if (t) openEditModal(t);
};

function openEditModal(topic) {
  document.getElementById('modal-title').innerText = 'Edit Keyword Group';
  document.getElementById('modal-group-id').value = topic.id;
  document.getElementById('modal-group-icon').value = topic.icon || '📌';
  document.getElementById('modal-group-name').value = topic.name;
  document.getElementById('modal-group-enabled').checked = topic.enabled !== false;
  
  const kwStr = (topic.keywords || []).join(', ');
  document.getElementById('modal-group-keywords').value = kwStr;
  
  // Re-initialize tags
  const container = document.getElementById('modal-tag-container');
  // Remove existing tags but keep the input
  const tags = container.querySelectorAll('.modal-tag');
  tags.forEach(t => t.remove());
  
  const keywords = kwStr ? kwStr.split(',').map(k => k.trim()).filter(Boolean) : [];
  const inputEl = document.getElementById('modal-tag-input');
  
  keywords.forEach(kw => {
    container.insertBefore(createTagPill(kw), inputEl);
  });
  
  document.getElementById('group-modal').classList.add('active');
}

// ─── MODAL TAG INPUT LOGIC ───
function createTagPill(text) {
  const pill = document.createElement('div');
  pill.className = 'modal-tag';
  
  const txtSpan = document.createElement('span');
  txtSpan.innerText = text;
  
  const closeBtn = document.createElement('span');
  closeBtn.className = 'modal-tag-remove';
  closeBtn.innerText = '×';
  closeBtn.onclick = () => {
    pill.remove();
    syncTagsToTextarea();
  };
  
  pill.appendChild(txtSpan);
  pill.appendChild(closeBtn);
  return pill;
}

function syncTagsToTextarea() {
  const container = document.getElementById('modal-tag-container');
  const tags = container.querySelectorAll('.modal-tag span:first-child');
  const keywords = Array.from(tags).map(t => t.innerText);
  document.getElementById('modal-group-keywords').value = keywords.join(', ');
}

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('modal-tag-container');
  const input = document.getElementById('modal-tag-input');
  
  if(container && input) {
    container.addEventListener('click', () => input.focus());
    
    input.addEventListener('input', (e) => {
      if (input.value.includes(',')) {
        const parts = input.value.split(',');
        const lastPart = parts.pop();
        parts.forEach(part => {
          const val = part.trim();
          if (val) {
            container.insertBefore(createTagPill(val), input);
          }
        });
        input.value = lastPart.trimStart();
        syncTagsToTextarea();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (val) {
          container.insertBefore(createTagPill(val), input);
          input.value = '';
          syncTagsToTextarea();
        }
      } else if (e.key === 'Backspace' && input.value === '') {
        const tags = container.querySelectorAll('.modal-tag');
        if (tags.length > 0) {
          tags[tags.length - 1].remove();
          syncTagsToTextarea();
        }
      }
    });

    // Removed blur listener to prevent layout shift during Save Group click
  }
});

function crawlGroup(id) {
  runtime.sendMessage({ action: 'run_manual_crawl', topicId: id }, (response) => {
    if (response === undefined && chrome.runtime.lastError) {
      console.warn('Crawl channel timed out. Relying on background progress events.');
      return;
    }
    if (response && response.success) {
      updateCrawlStatus();
      loadDashboardFeed();
    } else {
      alert('Crawl failed: ' + (response?.error || 'Unknown error'));
    }
  });
}

async function deleteGroup(id) {
  if (confirm('Delete this category shelf? It will be removed from both browser and TV dashboards.')) {
    const result = await storage.get(`${STORAGE_PREFIX}topics`);
    const topics = result[`${STORAGE_PREFIX}topics`] || [];
    const filtered = topics.filter(t => t.id !== id);
    
    await storage.set({ [`${STORAGE_PREFIX}topics`]: filtered });
    
    const autoSync = document.getElementById('sync-gh-auto')?.checked ?? true;
    if (autoSync) {
      syncTopicsToGitHub(filtered);
    }
    
    runtime.sendMessage({ action: 'delete_topic', id: id }, async () => {
      await loadTopics(true);
    });
  }
}

async function updateCrawlStatus() {
  const result = await storage.get([
    `${STORAGE_PREFIX}last_crawl_time`,
    `${STORAGE_PREFIX}supabase_url`,
    `${STORAGE_PREFIX}supabase_key`
  ]);
  const lastTime = result[`${STORAGE_PREFIX}last_crawl_time`];
  const url = result[`${STORAGE_PREFIX}supabase_url`];
  const key = result[`${STORAGE_PREFIX}supabase_key`];
  const statusEl = document.getElementById('header-crawl-status');
  
  if (url && key) {
    let nextStr = 'Calculating...';
    
    // Fetch actual alarm time
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      try {
        const alarm = await chrome.alarms.get('github_cloud_sync_alarm');
        if (alarm && alarm.scheduledTime) {
          nextStr = new Date(alarm.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
          nextStr = 'Pending...';
        }
      } catch (e) {
        nextStr = 'Unknown';
      }
    }

    if (lastTime) {
      statusEl.innerHTML = `<div style="display:flex; align-items:center; gap:1.5rem; font-size:0.8rem;">
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <span style="color:#aaa;">Last Local Sync:</span>
          <span style="color:#fff; font-weight:bold;">${new Date(lastTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <span title="Powered by precise Extension Alarms" style="color:#aaa;">Next Auto-Run:</span>
          <span style="color:#34d399; font-weight:bold;">${nextStr}</span>
        </div>
      </div>`;
    } else {
      statusEl.innerHTML = `<div style="display:flex; align-items:center; gap:1.5rem; font-size:0.8rem;">
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <span style="color:#aaa;">Ready for Crawl</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <span style="color:#aaa;">Next Auto-Run:</span>
          <span style="color:#34d399; font-weight:bold;">${nextStr}</span>
        </div>
      </div>`;
    }
  } else {
    // If no Supabase config is set, it might be because the user is using the GitHub runner
    // If we have a lastTime from GitHub, we should display it anyway.
    if (lastTime) {
      statusEl.innerHTML = `<div style="display:flex; align-items:center; gap:1.5rem; font-size:0.8rem;">
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <span style="color:#aaa;">Last Local Sync:</span>
          <span style="color:#fff; font-weight:bold;">${new Date(lastTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <span style="color:#aaa;">Cloud Runner:</span>
          <span style="color:#34d399; font-weight:bold;">Active</span>
        </div>
      </div>`;
    } else {
      statusEl.innerText = 'Setup Required';
      if (statusEl.parentElement) {
        statusEl.parentElement.style.color = '#ef4444';
      }
    }
  }
}

// Check and listen for active crawl progress
async function checkActiveCrawlProgress() {
  const result = await storage.get(`${STORAGE_PREFIX}crawl_progress`);
  const progressState = result[`${STORAGE_PREFIX}crawl_progress`];
  if (progressState && progressState.running) {
    updateProgressBar(progressState);
  }

  // Listen for message broadcasts from background script
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'crawl_progress') {
        updateProgressBar(message);
        if (message.status === 'completed') {
          setTimeout(() => {
            updateCrawlStatus();
            loadDashboardFeed();
          }, 1500);
        }
      } else if (message.action === 'cloud_sync_started') {
        console.log('[PulseTube] Received cloud_sync_started signal. Polling GitHub...');
        if (window.checkActiveCloudSync) window.checkActiveCloudSync();
      }
    });
  }
}

function updateProgressBar(state) {
  const container = document.getElementById('crawl-progress-bar-container');
  if (!container) return;

  if (state && state.running) {
    container.style.display = 'block';
    
    const taskEl = document.getElementById('progress-current-task');
    const percentEl = document.getElementById('progress-percentage');
    const fillEl = document.getElementById('crawl-progress-fill');
    const kwEl = document.getElementById('progress-stats-crawled');
    const countEl = document.getElementById('progress-stats-count');

    if (taskEl) taskEl.innerText = `Crawling YouTube: ${state.currentTopicName || 'Initializing...'}`;
    if (percentEl) percentEl.innerText = `${state.progressPercent || 0}%`;
    if (fillEl) fillEl.style.width = `${state.progressPercent || 0}%`;
    if (kwEl) kwEl.innerText = `Keyword: "${state.currentKeyword || '-'}"`;
    if (countEl) countEl.innerText = `${state.currentTopicIndex || 0} / ${state.totalTopics || 0} topics`;
  } else {
    // Gracefully hide after a brief delay
    setTimeout(() => {
      container.style.display = 'none';
    }, 1200);
  }
}

// ─── SUPABASE REALTIME UI SYNC ───
// Automatically update the dashboard when the background script upserts new videos to Supabase
function setupRealtimeSync(supabaseUrl, supabaseKey) {
  if (!supabaseUrl || !supabaseKey || typeof supabase === 'undefined') return;
  
  const sbClient = supabase.createClient(supabaseUrl, supabaseKey);
  
  sbClient.channel('custom-all-channel')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'videos_feed' },
      (payload) => {
        // Only trigger a re-render if the user is on the home view and not actively searching
        const currentView = document.querySelector('.sidebar-item.active')?.getAttribute('data-target');
        const isSearching = document.getElementById('search-bar').value.trim().length > 0;
        
        if (currentView === 'home' && !isSearching) {
          // Debounce the refresh to prevent UI stuttering during massive batch inserts
          clearTimeout(window._liveSyncTimeout);
          window._liveSyncTimeout = setTimeout(() => {
            console.log('[PulseTube Live] Realtime database update detected. Refreshing feed...');
            loadDashboardFeed();
          }, 2000);
        }
      }
    )
    .subscribe();
}

// Trigger setup when credentials are known
storage.get([`${STORAGE_PREFIX}supabase_url`, `${STORAGE_PREFIX}supabase_key`]).then(res => {
  setupRealtimeSync(res[`${STORAGE_PREFIX}supabase_url`], res[`${STORAGE_PREFIX}supabase_key`]);
});

let _syncTopicsTimeout = null;
let _isSyncTopicsActive = false;
let _pendingSyncTopics = null;

async function syncTopicsToGitHub(topics, immediate = false) {
  _pendingSyncTopics = topics;
  
  const executeSync = async () => {
    if (_isSyncTopicsActive) {
      _syncTopicsTimeout = setTimeout(executeSync, 1500);
      return;
    }
    
    _isSyncTopicsActive = true;
    const topicsToSync = _pendingSyncTopics;
    
    try {
      const result = await storage.get([`${STORAGE_PREFIX}github_repo`, `${STORAGE_PREFIX}github_token`, `${STORAGE_PREFIX}tv_sync_enabled`]);
      const repo = result[`${STORAGE_PREFIX}github_repo`] || 'shrik7891-pixel/pulsetube-next';
      const token = result[`${STORAGE_PREFIX}github_token`];
      const isSyncEnabled = result[`${STORAGE_PREFIX}tv_sync_enabled`] !== false;

      if (!token || !isSyncEnabled) {
        _isSyncTopicsActive = false;
        return;
      }

      // 1. Get current file SHA to update it
      let sha = '';
      const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/topics.json?ref=main&t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        cache: 'no-store'
      });
      if (fileRes.ok) {
        const fileData = await fileRes.json();
        sha = fileData.sha;
      }

      // 2. Base64 encode the topics
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(topicsToSync, null, 2))));
      
      // Helper to execute PUT with auto-retry for 409 conflicts
      const doPutWithRetry = async (url, bodyObj, initialRes) => {
        let res = initialRes;
        if (!res.ok && res.status === 409) {
          const errData = await res.json();
          const match = errData.message && errData.message.match(/does not match ([a-f0-9]{40})/);
          if (match) {
            console.log('409 Conflict: Retrying with correct write-master SHA:', match[1]);
            bodyObj.sha = match[1];
            res = await fetch(url, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(bodyObj)
            });
          } else {
            // Re-wrap the error data so it can be read by the caller if needed
            res._errorText = JSON.stringify(errData);
          }
        }
        return res;
      };
      
      // 3. PUT file to main
      const mainUrl = `https://api.github.com/repos/${repo}/contents/topics.json`;
      const mainBody = {
        message: 'chore: format generic configuration vectors',
        content: content,
        branch: 'main',
        sha: sha || undefined
      };
      let putRes = await fetch(mainUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mainBody)
      });
      
      putRes = await doPutWithRetry(mainUrl, mainBody, putRes);
      
      if (putRes.ok) {
        console.log('Successfully synced topics.json to GitHub!');
      } else {
        console.error('Failed to sync topics to GitHub:', putRes._errorText || await putRes.text());
      }

      // 4. Update topics_latest.json on prod branch for TV
      let shaProd = '';
      const fileResProd = await fetch(`https://api.github.com/repos/${repo}/contents/topics_latest.json?ref=prod&t=${Date.now()}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        cache: 'no-store'
      });
      if (fileResProd.ok) {
        const fileDataProd = await fileResProd.json();
        shaProd = fileDataProd.sha;
      }
      
      const prodUrl = `https://api.github.com/repos/${repo}/contents/topics_latest.json`;
      const prodBody = {
        message: 'chore: update tv topics',
        content: content,
        branch: 'prod',
        sha: shaProd || undefined
      };
      let putResProd = await fetch(prodUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(prodBody)
      });
      
      putResProd = await doPutWithRetry(prodUrl, prodBody, putResProd);
      
      if (putResProd.ok) {
        console.log('Successfully synced topics_latest.json to prod!');
        // 5. Purge jsDelivr cache to ensure TV gets the update instantly
        try {
          await fetch(`https://purge.jsdelivr.net/gh/${repo}@prod/topics_latest.json`);
          await fetch(`https://purge.jsdelivr.net/gh/${repo}@main/topics.json`);
          console.log('Purged jsDelivr cache successfully');
        } catch(purgeErr) {
          console.warn('Failed to purge jsdelivr cache', purgeErr);
        }
      } else {
        console.error('Failed to sync topics_latest.json to prod:', putResProd._errorText || await putResProd.text());
      }
    } catch (e) {
      console.error('Error syncing topics to GitHub:', e);
    } finally {
      _isSyncTopicsActive = false;
    }
  };

  if (immediate) {
    if (_syncTopicsTimeout) clearTimeout(_syncTopicsTimeout);
    return executeSync();
  }

  if (_syncTopicsTimeout) clearTimeout(_syncTopicsTimeout);
  _syncTopicsTimeout = setTimeout(executeSync, 1500);
}

