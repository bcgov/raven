/**
 * Discover view — list all apps on a server with color badges.
 */
window.views = window.views || {};

/** Deterministic color for app names. */
function discoverAppColor(name) {
  const colors = [
    { bg: 'rgba(59,130,246,0.15)', fg: '#93c5fd' },
    { bg: 'rgba(139,92,246,0.15)', fg: '#c4b5fd' },
    { bg: 'rgba(236,72,153,0.15)', fg: '#f9a8d4' },
    { bg: 'rgba(34,197,94,0.15)',  fg: '#86efac' },
    { bg: 'rgba(234,179,8,0.15)',  fg: '#fde68a' },
    { bg: 'rgba(249,115,22,0.15)', fg: '#fdba74' },
    { bg: 'rgba(14,165,233,0.15)', fg: '#7dd3fc' },
    { bg: 'rgba(168,85,247,0.15)', fg: '#d8b4fe' },
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

/** Format an ISO timestamp as "X min ago" / "X hr ago" / "X d ago". */
function discoverFormatAge(iso) {
  if (!iso) return '';
  const ageMs = Date.now() - new Date(iso).getTime();
  if (ageMs < 60_000) return 'just now';
  const min = Math.floor(ageMs / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.floor(hr / 24)} d ago`;
}

window.views.discover = {
  render() {
    return `
      <div>
        <h2 class="section-title">Discover Apps</h2>
        <form id="disc-form" class="flex gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Server</label>
            ${window.createServerPicker('disc-server')}
          </div>
          <button type="submit" id="disc-btn" class="btn-primary">Discover</button>
        </form>
        <div id="disc-staleness" class="text-xs text-gray-500 mb-2">&nbsp;</div>
        <div id="disc-result" class="card">
          <p class="text-gray-500">Select a server and click "Discover" to list all deployed apps.</p>
        </div>
      </div>
    `;
  },

  async init() {
    const stalenessEl = document.getElementById('disc-staleness');
    const cacheTimestamps = new Map();

    // Load cache once for staleness display — no SSH, just the on-disk cache.
    try {
      const cacheRes = await fetch('/api/discover/cache');
      const cacheData = await cacheRes.json();
      for (const s of cacheData.servers || []) {
        if (s.discoveredAt) cacheTimestamps.set(s.server, s.discoveredAt);
      }
    } catch { /* ignore — no staleness shown on fetch failure */ }

    function showStaleness(server) {
      const ts = cacheTimestamps.get(server);
      stalenessEl.textContent = ts
        ? `Cached: ${discoverFormatAge(ts)} — click Discover to refresh`
        : 'Not yet cached for this server';
    }

    const picker = document.getElementById('disc-server');
    if (picker.value) showStaleness(picker.value);
    picker.addEventListener('change', () => showStaleness(picker.value));

    document.getElementById('disc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const server = document.getElementById('disc-server').value;
      const result = document.getElementById('disc-result');
      result.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Discovering apps...</div>';

      try {
        const res = await fetch(`/api/discover/${server}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Update staleness map and global app cache after a fresh discover
        if (data.discoveredAt) {
          cacheTimestamps.set(server, data.discoveredAt);
          showStaleness(server);
        }
        // Always merge — even an empty array is a valid discovery result
        // (server had apps, now has none after an undeploy). Skipping the
        // merge would leave stale apps in the global dropdown cache.
        if (data.apps) {
          window.mergeServerDiscovery(server, data.apps);
        }

        if (!data.apps || data.apps.length === 0) {
          result.innerHTML = '<p class="text-gray-500">No apps found.</p>';
          return;
        }

        const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        result.innerHTML = `
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-gray-500">${data.apps.length} components deployed</span>
            <button type="button" id="disc-csv-btn" class="btn-csv">&#128190; Export CSV</button>
          </div>
          <div style="overflow-x:auto">
          ${window.renderTable(
            [
              { key: 'app', label: 'App', render: (r) => {
                const c = discoverAppColor(r.app);
                return `<span class="app-badge" style="background:${c.bg};color:${c.fg}">${escHtml(r.app)}</span>`;
              }},
              { key: 'component', label: 'Component' },
              { key: 'version', label: 'Version', render: (r) => `<span class="font-mono text-gray-300">${escHtml(r.version)}</span>` },
              { key: 'port', label: 'Port' },
            ],
            data.apps
          )}
          </div>
        `;
        document.getElementById('disc-csv-btn')?.addEventListener('click', () => {
          window.exportTableToCsv(result.querySelector('table'), 'discover-' + server + '.csv');
        });
      } catch (err) {
        result.innerHTML = `<p class="text-red-400">${err.message}</p>`;
        window.showToast(err.message, 'error');
      }
    });
  }
};
