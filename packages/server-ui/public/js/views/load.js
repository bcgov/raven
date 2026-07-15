/**
 * Server Load view — uptime, load averages, memory, disk.
 * Supports SSE auto-refresh similar to JVM Heap.
 */
window.views = window.views || {};

window.views.load = {
  _eventSource: null,
  _updateCount: 0,
  _currentServers: [],

  render() {
    return `
      <div>
        <h2 class="section-title">Server Load</h2>
        <form id="load-form" class="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Server</label>
            ${window.createServerPicker('load-server')}
          </div>
          <button type="submit" id="load-btn" class="btn-primary">Fetch</button>
          <button type="button" id="load-all-btn" class="btn-secondary">All Servers</button>
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer ml-2">
            <input type="checkbox" id="load-auto" class="accent-blue-500">
            Auto-refresh (10s)
          </label>
          <span id="load-live" style="display:none" class="live-indicator">
            <span class="live-dot"></span> Live
            <span id="load-update-count" class="text-xs text-gray-500 ml-1"></span>
          </span>
        </form>
        <div id="load-result" class="card">
          <p class="text-gray-500">Select a server or click "All Servers" to view system load.</p>
        </div>
      </div>
    `;
  },

  async init() {
    const self = this;

    document.getElementById('load-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      self.stopStream();
      const server = document.getElementById('load-server').value;
      self._currentServers = [server];
      const autoOn = document.getElementById('load-auto').checked;
      if (autoOn) {
        self.startStream();
      } else {
        await self.fetchLoad([server]);
      }
    });

    document.getElementById('load-all-btn').addEventListener('click', async () => {
      self.stopStream();
      self._currentServers = window.getServerNames();
      const autoOn = document.getElementById('load-auto').checked;
      if (autoOn) {
        self.startStream();
      } else {
        await self.fetchLoad(window.getServerNames());
      }
    });

    document.getElementById('load-auto').addEventListener('change', (e) => {
      if (e.target.checked) {
        self.startStream();
      } else {
        self.stopStream();
      }
    });
  },

  async fetchLoad(servers) {
    const result = document.getElementById('load-result');
    result.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Fetching server load...</div>';

    try {
      const results = await Promise.all(
        servers.map(async (s) => {
          const res = await fetch(`/api/load/${s}`);
          return res.json();
        })
      );

      this.renderResults(results, false);
    } catch (err) {
      result.innerHTML = `<p class="text-red-400">${err.message}</p>`;
      window.showToast(err.message, 'error');
    }
  },

  startStream() {
    this.stopStream();
    this._updateCount = 0;

    // Determine which servers to stream
    const servers = this._currentServers.length > 0
      ? this._currentServers
      : [document.getElementById('load-server').value];

    const allNames = window.getServerNames();
    const serverParam = servers.length === allNames.length ? 'all' : servers[0];
    const params = new URLSearchParams({ interval: '10' });
    this._eventSource = new EventSource(`/api/load/stream/${serverParam}?${params}`);

    this._eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.error) throw new Error(data.error);
        this._updateCount++;
        // Stream returns an array of server results
        const results = Array.isArray(data) ? data : [data];
        this.renderResults(results, true);
      } catch (err) {
        console.error('Load SSE parse error:', err);
      }
    };

    this._eventSource.onerror = () => {
      this.stopStream();
      document.getElementById('load-auto').checked = false;
      window.showToast('SSE connection lost — auto-refresh stopped', 'error');
    };

    document.getElementById('load-live').style.display = 'inline-flex';
  },

  stopStream() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
    this._updateCount = 0;
    const liveEl = document.getElementById('load-live');
    if (liveEl) liveEl.style.display = 'none';
    const countEl = document.getElementById('load-update-count');
    if (countEl) countEl.textContent = '';
  },

  renderResults(results, isStreaming) {
    const resultEl = document.getElementById('load-result');

    // Update the poll counter in the live badge
    if (isStreaming) {
      const countEl = document.getElementById('load-update-count');
      if (countEl) countEl.textContent = `#${this._updateCount}`;
    }

    const now = new Date().toLocaleTimeString();
    const flashClass = isStreaming ? 'heap-flash' : '';

    // Use single column for 1 server, 2 cols for 2-3 servers
    const colClass = results.length === 1 ? '' : 'md:grid-cols-2';
    let html = '';

    if (isStreaming) {
      html += `<div class="flex items-center gap-2 mb-3 text-xs ${isStreaming ? 'text-green-400' : 'text-gray-500'}">
        <span>● Polled at ${now}${isStreaming ? ' (#' + this._updateCount + ')' : ''}</span>
      </div>`;
    }

    html += `<div class="grid gap-4 ${colClass} ${flashClass}">`;
    for (const data of results) {
      if (data.error) {
        html += `<div class="card border-red-900"><h3 class="text-white font-semibold mb-2">${data.server || '?'}</h3><p class="text-red-400">${data.error}</p></div>`;
        continue;
      }
      html += this.renderCard(data);
    }
    html += '</div>';
    resultEl.innerHTML = html;
  },

  renderCard(data) {
    if (data.raw) {
      return `<div class="card"><h3 class="text-white font-semibold mb-2">${data.server}</h3><pre class="log-output text-xs">${data.raw}</pre></div>`;
    }

    const l = data.load;
    const loadColor = (v) => v > 4 ? 'text-red-400' : v > 2 ? 'text-yellow-400' : 'text-green-400';
    const memColor = l.memPercent > 90 ? 'bar-red' : l.memPercent > 75 ? 'bar-orange' : l.memPercent > 50 ? 'bar-yellow' : 'bar-green';

    let diskHtml = '';
    if (l.disks && l.disks.length > 0) {
      diskHtml = `
        <div class="mt-3">
          <span class="text-xs text-gray-500">Disk</span>
          <div style="overflow-x:auto; max-height:18rem; overflow-y:auto; margin-top:0.25rem">
            <table class="data-table data-table-compact" style="table-layout:auto">
              <thead><tr><th>Mount</th><th>Size</th><th>Used</th><th>Avail</th><th>Use%</th></tr></thead>
              <tbody>`;
      for (const d of l.disks) {
        const pct = parseInt(d.usePercent) || 0;
        const cls = pct > 90 ? 'text-red-400 font-semibold' : pct > 75 ? 'text-yellow-400' : '';
        diskHtml += `<tr>
          <td title="${escapeHtml(d.mountpoint)}" class="font-mono">${escapeHtml(d.mountpoint)}</td>
          <td>${d.size}</td>
          <td>${d.used}</td>
          <td>${d.available || '—'}</td>
          <td class="${cls}">${d.usePercent}</td>
        </tr>`;
      }
      diskHtml += '</tbody></table></div></div>';
    }

    const serverLabel = window.getServerRole(data.server);

    return `
      <div class="card" style="overflow:hidden">
        <h3 class="text-white font-semibold mb-1">${data.server} <span class="text-xs text-gray-500">(${serverLabel})</span></h3>
        <p class="text-xs text-gray-500 mb-3">Uptime: ${l.uptime}</p>
        <div class="flex gap-4 text-sm mb-3">
          <div>
            <span class="text-xs text-gray-500">1m</span>
            <div class="${loadColor(l.load1)} font-mono font-bold">${l.load1.toFixed(2)}</div>
          </div>
          <div>
            <span class="text-xs text-gray-500">5m</span>
            <div class="${loadColor(l.load5)} font-mono font-bold">${l.load5.toFixed(2)}</div>
          </div>
          <div>
            <span class="text-xs text-gray-500">15m</span>
            <div class="${loadColor(l.load15)} font-mono font-bold">${l.load15.toFixed(2)}</div>
          </div>
        </div>
        <div>
          <div class="flex justify-between text-xs text-gray-500 mb-1">
            <span>Memory</span>
            <span>${l.memUsedMb} / ${l.memTotalMb} MB</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill ${memColor}" style="width: ${Math.min(l.memPercent, 100)}%"></div>
            <div class="bar-label">${l.memPercent.toFixed(1)}%</div>
          </div>
        </div>
        ${diskHtml}
      </div>
    `;
  }
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
