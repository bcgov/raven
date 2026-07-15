/**
 * Log Tail view — real-time log polling.
 * Like `tail -f` in the browser, using fetch-based polling
 * against the one-shot /api/logs/tail endpoint.
 */
window.views = window.views || {};

window.views.logtail = {
  _timer: null,
  _updateCount: 0,
  _paused: false,
  _lineCount: 0,
  _seenSignature: '',   // hash of last fetched lines to detect changes
  _currentParams: null,  // params object for the active tail session

  render() {
    const firstApp = window.appData.apps[0] || '';
    return `
      <div>
        <h2 class="section-title">Log Tail</h2>
        <form id="tail-form" class="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Server</label>
            ${window.createServerPicker('tail-server')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">App</label>
            ${window.createAppPicker('tail-app')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Component</label>
            ${window.createComponentPicker('tail-comp', firstApp)}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Log Type</label>
            <select id="tail-type" class="form-select">
              <option value="app">app</option>
              <option value="catalina">catalina</option>
              <option value="access">access</option>
            </select>
          </div>
          <button type="submit" id="tail-start-btn" class="btn-primary">Start Tailing</button>
          <button type="button" id="tail-stop-btn" class="btn-secondary" style="display:none">Stop</button>
          <button type="button" id="tail-pause-btn" class="btn-secondary" style="display:none">Pause</button>
          <button type="button" id="tail-clear-btn" class="btn-secondary" style="display:none">Clear</button>
          <span id="tail-live" style="display:none" class="live-indicator">
            <span class="live-dot"></span> Live
            <span id="tail-update-count" class="text-xs text-gray-500 ml-1"></span>
          </span>
        </form>
        <div id="tail-status" class="text-xs text-gray-500 mb-2"></div>
        <div id="tail-output" class="tail-output" style="display:none"></div>
        <div id="tail-placeholder" class="card">
          <p class="text-gray-500">Select server, app, and component then click "Start Tailing" to stream live logs.</p>
        </div>
      </div>
    `;
  },

  async init() {
    const self = this;

    document.getElementById('tail-app').addEventListener('change', (e) => {
      window.updateComponentPicker('tail-comp', e.target.value);
    });

    document.getElementById('tail-form').addEventListener('submit', (e) => {
      e.preventDefault();
      self.startTailing();
    });

    document.getElementById('tail-stop-btn').addEventListener('click', () => {
      self.stopTailing();
    });

    document.getElementById('tail-pause-btn').addEventListener('click', () => {
      self._paused = !self._paused;
      document.getElementById('tail-pause-btn').textContent = self._paused ? 'Resume' : 'Pause';
    });

    document.getElementById('tail-clear-btn').addEventListener('click', () => {
      document.getElementById('tail-output').innerHTML = '';
      self._lineCount = 0;
      document.getElementById('tail-status').textContent = '';
    });
  },

  /** Start polling the one-shot tail endpoint. */
  startTailing() {
    // Stop any existing polling first
    this.stopTailing();

    // Read form values NOW and lock them for this session
    const server = document.getElementById('tail-server').value;
    const app = document.getElementById('tail-app').value.trim();
    const component = document.getElementById('tail-comp').value.trim();
    const logType = document.getElementById('tail-type').value;

    if (!app || !component) {
      window.showToast('Select an app and component first', 'error');
      return;
    }

    // Store the params so the polling loop uses these exact values
    this._currentParams = { server, app, component, logType };
    this._updateCount = 0;
    this._lineCount = 0;
    this._paused = false;
    this._seenSignature = '';

    const output = document.getElementById('tail-output');
    const placeholder = document.getElementById('tail-placeholder');
    output.style.display = 'block';
    output.innerHTML = '<span class="text-gray-500">Loading...</span>';
    placeholder.style.display = 'none';
    document.getElementById('tail-status').textContent =
      `Fetching ${app}/${component} on ${server} (${logType})...`;

    // Show/hide buttons
    document.getElementById('tail-start-btn').style.display = 'none';
    document.getElementById('tail-stop-btn').style.display = '';
    document.getElementById('tail-pause-btn').style.display = '';
    document.getElementById('tail-clear-btn').style.display = '';
    document.getElementById('tail-pause-btn').textContent = 'Pause';
    document.getElementById('tail-live').style.display = 'inline-flex';

    // Fetch immediately, then poll every 3 seconds
    this._fetchTail(true);
    this._timer = setInterval(() => this._fetchTail(false), 3000);
  },

  /** Stop polling. */
  stopTailing() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._currentParams = null;
    this._updateCount = 0;

    const liveEl = document.getElementById('tail-live');
    if (liveEl) liveEl.style.display = 'none';
    const startBtn = document.getElementById('tail-start-btn');
    if (startBtn) startBtn.style.display = '';
    const stopBtn = document.getElementById('tail-stop-btn');
    if (stopBtn) stopBtn.style.display = 'none';
    const pauseBtn = document.getElementById('tail-pause-btn');
    if (pauseBtn) pauseBtn.style.display = 'none';
    const clearBtn = document.getElementById('tail-clear-btn');
    if (clearBtn) clearBtn.style.display = 'none';
    const countEl = document.getElementById('tail-update-count');
    if (countEl) countEl.textContent = '';
  },

  /** Fetch the latest tail from the one-shot endpoint. */
  async _fetchTail(isFirst) {
    const p = this._currentParams;
    if (!p) return; // stopped

    const output = document.getElementById('tail-output');
    if (!output) return; // navigated away

    try {
      const qs = new URLSearchParams({
        server: p.server,
        app: p.app,
        component: p.component,
        logType: p.logType,
        lines: '200'
      });
      const url = `/api/logs/tail?${qs}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        if (isFirst) output.innerHTML = `<span class="text-red-400">${escapeHtml(data.error)}</span>`;
        return;
      }

      // Guard: if params changed while we were fetching, discard
      if (this._currentParams !== p) return;

      this._updateCount++;
      const countEl = document.getElementById('tail-update-count');
      if (countEl) countEl.textContent = `#${this._updateCount}`;

      if (this._paused) return;

      const lines = data.lines || [];
      // Build a simple signature to detect new content
      const sig = lines.length + ':' + (lines[lines.length - 1] || '');

      if (isFirst) {
        // First fetch — render all lines
        output.innerHTML = lines.map(l => `<div class="log-line-text">${escapeHtml(l)}</div>`).join('');
        this._lineCount = lines.length;
        this._seenSignature = sig;
      } else if (sig !== this._seenSignature) {
        // Content changed — find new lines by comparing from the end
        const oldSig = this._seenSignature;
        this._seenSignature = sig;

        // Simple approach: re-render all lines but highlight new ones at the end
        const oldCount = this._lineCount;
        output.innerHTML = '';
        for (let i = 0; i < lines.length; i++) {
          const div = document.createElement('div');
          div.className = i >= oldCount ? 'log-line-text tail-line-new' : 'log-line-text';
          div.textContent = lines[i];
          output.appendChild(div);
        }
        this._lineCount = lines.length;
      }

      // Auto-scroll to bottom
      output.scrollTop = output.scrollHeight;

      // Update status
      document.getElementById('tail-status').textContent =
        `${p.app}/${p.component} on ${p.server} (${p.logType}) — ${this._lineCount} lines | Poll #${this._updateCount} | ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      console.error('Tail fetch error:', err);
      if (isFirst) {
        output.innerHTML = `<span class="text-red-400">Failed to fetch log: ${escapeHtml(err.message)}</span>`;
      }
    }
  }
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
