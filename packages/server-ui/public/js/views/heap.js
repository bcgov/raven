/**
 * JVM Heap view — visual heap bars with optional SSE auto-refresh.
 */
window.views = window.views || {};

window.views.heap = {
  _eventSource: null,
  _updateCount: 0,

  render() {
    const firstApp = window.appData.apps[0] || '';
    return `
      <div>
        <h2 class="section-title">JVM Heap</h2>
        <form id="heap-form" class="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Server</label>
            ${window.createServerPicker('heap-server')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">App</label>
            ${window.createAppPicker('heap-app')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Component</label>
            ${window.createComponentPicker('heap-comp', firstApp)}
          </div>
          <button type="submit" id="heap-btn" class="btn-primary">Fetch</button>
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer ml-2">
            <input type="checkbox" id="heap-auto" class="accent-blue-500">
            Auto-refresh (5s)
          </label>
          <span id="heap-live" style="display:none" class="live-indicator">
            <span class="live-dot"></span> Live
            <span id="heap-update-count" class="text-xs text-gray-500 ml-1"></span>
          </span>
        </form>
        <div id="heap-result" class="card card-visible">
          <p class="text-gray-500">Select server, app, and component then click "Fetch" for a heap snapshot, or enable "Auto-refresh" for live monitoring.</p>
        </div>
      </div>
    `;
  },

  async init(params) {
    const self = this;

    document.getElementById('heap-app').addEventListener('change', (e) => {
      window.updateComponentPicker('heap-comp', e.target.value);
    });

    document.getElementById('heap-form').addEventListener('submit', (e) => {
      e.preventDefault();
      self.fetchHeap();
    });

    document.getElementById('heap-auto').addEventListener('change', (e) => {
      if (e.target.checked) {
        self.startStream();
      } else {
        self.stopStream();
      }
    });

    // Pre-fill from URL params (e.g. from dashboard heap link)
    if (params) {
      if (params.server) document.getElementById('heap-server').value = params.server;
      if (params.app) {
        document.getElementById('heap-app').value = params.app;
        window.updateComponentPicker('heap-comp', params.app);
        await new Promise(r => setTimeout(r, 0));
      }
      if (params.component) document.getElementById('heap-comp').value = params.component;

      // Auto-fetch if we have enough info
      if (params.app && params.component) {
        this.fetchHeap();
      }
    }
  },

  async fetchHeap() {
    const server = document.getElementById('heap-server').value;
    const app = document.getElementById('heap-app').value.trim();
    const component = document.getElementById('heap-comp').value.trim();

    if (!app || !component) {
      window.showToast('App and component are required', 'error');
      return;
    }

    const result = document.getElementById('heap-result');
    result.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Fetching heap...</div>';

    try {
      const params = new URLSearchParams({ server, app, component });
      const res = await fetch(`/api/heap?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.renderHeapData(data, false);
    } catch (err) {
      result.innerHTML = `<p class="text-red-400">${err.message}</p>`;
      window.showToast(err.message, 'error');
    }
  },

  startStream() {
    this.stopStream();
    this._updateCount = 0;
    const server = document.getElementById('heap-server').value;
    const app = document.getElementById('heap-app').value.trim();
    const component = document.getElementById('heap-comp').value.trim();

    if (!app || !component) {
      window.showToast('Select an app and component first, then enable auto-refresh', 'error');
      document.getElementById('heap-auto').checked = false;
      return;
    }

    const liveEl = document.getElementById('heap-live');
    const params = new URLSearchParams({ server, app, component, interval: '5' });
    this._eventSource = new EventSource(`/api/heap/stream?${params}`);

    this._eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.error) throw new Error(data.error);
        this._updateCount++;
        this.renderHeapData(data, true);
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    this._eventSource.onerror = () => {
      this.stopStream();
      document.getElementById('heap-auto').checked = false;
      window.showToast('SSE connection lost — auto-refresh stopped', 'error');
    };

    liveEl.style.display = 'inline-flex';
  },

  stopStream() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
    this._updateCount = 0;
    const liveEl = document.getElementById('heap-live');
    if (liveEl) liveEl.style.display = 'none';
    const countEl = document.getElementById('heap-update-count');
    if (countEl) countEl.textContent = '';
  },

  renderHeapData(data, isStreaming) {
    const result = document.getElementById('heap-result');
    if (data.raw) {
      result.innerHTML = `<pre class="log-output">${escapeHtml(data.raw)}</pre>`;
      return;
    }

    // Update the poll counter in the live badge
    if (isStreaming) {
      const countEl = document.getElementById('heap-update-count');
      if (countEl) countEl.textContent = `#${this._updateCount}`;
    }

    const h = data.heap;
    const now = new Date().toLocaleTimeString();

    // Flash the card border on update to signal new data
    const flashClass = isStreaming ? 'heap-flash' : '';

    result.innerHTML = `
      <div class="space-y-4 ${flashClass}">
        <div class="flex items-center gap-3 text-sm text-gray-400 flex-wrap">
          <span>${tip('Process ID of the Tomcat JVM')}PID: <span class="text-white font-mono">${h.pid}</span></span>
          <span>${tip('Young Generation Garbage Collections — minor GCs that clean short-lived objects')}YGC: <span class="font-mono">${h.youngGcCount}</span> (${h.youngGcTime}s)</span>
          <span>${tip('Full Garbage Collections — major GCs that pause the JVM to clean all generations. High counts or long times indicate memory pressure')}FGC: <span class="font-mono">${h.fullGcCount}</span> (${h.fullGcTime}s)</span>
          <span class="ml-auto text-xs ${isStreaming ? 'text-green-400' : 'text-gray-600'}">
            ${isStreaming ? '● Polled' : 'Fetched'} at ${now}${isStreaming ? ' (#' + this._updateCount + ')' : ''}
          </span>
        </div>
        ${heapBar('Heap', h.heapUsedMb, h.heapMaxMb, h.heapPercent, 'Total JVM heap memory (Eden + Old Gen). If consistently above 85%, consider increasing -Xmx')}
        ${heapBar('Eden', h.edenUsedMb, h.edenMaxMb, h.edenPercent, 'Eden space — where new objects are allocated. Fluctuates rapidly as minor GCs clean it. High churn is normal')}
        ${heapBar('Old Gen', h.oldUsedMb, h.oldMaxMb, h.oldPercent, 'Old Generation — long-lived objects promoted from Eden. Steadily increasing usage may indicate a memory leak')}
        ${heapBar('Metaspace', h.metaUsedMb, h.metaMaxMb, h.metaPercent, 'Metaspace — stores class metadata. High usage can indicate too many classes loaded or a classloader leak')}
      </div>
    `;
  }
};

function heapBar(label, used, max, pct, tooltip) {
  const color = pct > 90 ? 'bar-red' : pct > 75 ? 'bar-orange' : pct > 50 ? 'bar-yellow' : 'bar-green';
  return `
    <div>
      <div class="flex justify-between text-xs text-gray-500 mb-1">
        <span>${tip(tooltip)}${label}</span>
        <span class="font-mono">${used.toFixed(1)} / ${max.toFixed(1)} MB</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${color}" style="width: ${Math.min(pct, 100)}%"></div>
        <div class="bar-label">${pct.toFixed(1)}%</div>
      </div>
    </div>
  `;
}

/** Render a ⓘ help icon with a CSS tooltip. */
function tip(text) {
  return `<span class="heap-tip">&#9432;<span class="tip-text">${escapeHtml(text)}</span></span>`;
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
