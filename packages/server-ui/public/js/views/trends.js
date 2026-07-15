/**
 * Error trends view — Chart.js bar chart of error counts over time.
 */
window.views = window.views || {};

/** Environment colors for server datasets. */
const ENV_COLORS = {
  DEV:  { bg: 'rgba(59,130,246,0.6)',  border: '#3b82f6' },
  TEST: { bg: 'rgba(234,179,8,0.6)',   border: '#eab308' },
  PROD: { bg: 'rgba(239,68,68,0.6)',   border: '#ef4444' },
};

function getEnvColor(serverName) {
  const role = window.getServerRole ? window.getServerRole(serverName) : '';
  return ENV_COLORS[role] || { bg: 'rgba(148,163,184,0.6)', border: '#94a3b8' };
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a ⓘ help icon with a CSS tooltip. */
function tip(text) {
  return `<span class="heap-tip">&#9432;<span class="tip-text">${escapeHtml(text)}</span></span>`;
}

window.views.trends = {
  _chart: null,

  render() {
    return `
      <div>
        <h2 class="section-title">Error Trends</h2>
        <form id="trends-form" class="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">${tip('Filter by application. Leave as "All apps" to see errors across all applications.')}App (optional)</label>
            ${window.createAppPicker('trends-app', true)}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">${tip('Filter by component (e.g. rrs-api, dms-web). Only available when an app is selected.')}Component (optional)</label>
            ${window.createComponentPicker('trends-comp', '')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">${tip('Filter by server environment. DEV=int01, TEST=test01, PROD=prod01.')}Server (optional)</label>
            ${window.createServerPicker('trends-server', true)}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">${tip('How far back to chart. Longer ranges show broader trends; shorter ranges show recent spikes.')}Date range</label>
            <select id="trends-days" class="form-select">
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30" selected>Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </div>
          <button type="submit" class="btn-primary">Load Trends</button>
        </form>
        <div class="card" style="position:relative;min-height:380px;margin-bottom:1rem">
          <div id="trends-empty" class="text-center text-gray-500 py-16" style="display:none">
            <p class="text-lg mb-2">No error data collected yet</p>
            <p class="text-sm">Data appears after the background collector runs. The collector polls every 30 minutes.</p>
          </div>
          <canvas id="trends-canvas"></canvas>
        </div>
        <div id="trends-summary" class="card" style="display:none"></div>
      </div>
    `;
  },

  init() {
    document.getElementById('trends-app').addEventListener('change', (e) => {
      const app = e.target.value;
      // When "All apps" selected, clear component and add "All" option
      if (!app) {
        const compEl = document.getElementById('trends-comp');
        compEl.innerHTML = '<option value="">All components</option>';
      } else {
        window.updateComponentPicker('trends-comp', app);
        // Prepend "All components" option
        const compEl = document.getElementById('trends-comp');
        compEl.insertAdjacentHTML('afterbegin', '<option value="">All components</option>');
      }
    });

    // Initialize component picker with "All components" when "All apps" is default
    const appEl = document.getElementById('trends-app');
    if (!appEl.value) {
      document.getElementById('trends-comp').innerHTML = '<option value="">All components</option>';
    }

    document.getElementById('trends-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.loadTrends();
    });
  },

  async loadTrends() {
    const app = document.getElementById('trends-app').value.trim();
    const component = document.getElementById('trends-comp').value.trim();
    const server = document.getElementById('trends-server').value.trim();
    const days = document.getElementById('trends-days').value;

    const params = new URLSearchParams({ days });
    if (app) params.set('app', app);
    if (component) params.set('component', component);
    if (server) params.set('server', server);

    try {
      const res = await fetch(`/api/trends/errors?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.renderChart(data.snapshots, parseInt(days));
      this.renderSummary(data.snapshots);
    } catch (err) {
      window.showToast(err.message, 'error');
    }
  },

  renderChart(snapshots, days) {
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }

    const emptyEl = document.getElementById('trends-empty');
    const canvas = document.getElementById('trends-canvas');

    if (snapshots.length === 0) {
      canvas.style.display = 'none';
      emptyEl.style.display = 'block';
      return;
    }

    canvas.style.display = 'block';
    emptyEl.style.display = 'none';

    // Group by date and server
    const dateMap = {};
    const serverSet = new Set();
    for (const s of snapshots) {
      const date = s.ts.slice(0, 10); // YYYY-MM-DD
      serverSet.add(s.server);
      if (!dateMap[date]) dateMap[date] = {};
      if (!dateMap[date][s.server]) dateMap[date][s.server] = 0;
      dateMap[date][s.server] += s.count;
    }

    // Build date labels (fill gaps)
    const labels = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      labels.push(d.toISOString().slice(0, 10));
    }

    const servers = [...serverSet].sort();
    const datasets = servers.map(srv => {
      const color = getEnvColor(srv);
      const role = window.getServerRole ? window.getServerRole(srv) : srv;
      return {
        label: `${srv} (${role})`,
        data: labels.map(date => dateMap[date]?.[srv] || 0),
        backgroundColor: color.bg,
        borderColor: color.border,
        borderWidth: 1,
      };
    });

    // Theme-aware chart colors
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue('--text-secondary').trim() || '#9ca3af';
    const gridColor = style.getPropertyValue('--border').trim() || '#374151';

    this._chart = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: textColor, boxWidth: 12 }
          },
          tooltip: { mode: 'index' }
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: textColor, maxRotation: 45 },
            grid: { color: gridColor }
          },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { color: textColor },
            grid: { color: gridColor },
            title: { display: true, text: 'Error Count', color: textColor }
          }
        }
      }
    });
  },

  renderSummary(snapshots) {
    const summary = document.getElementById('trends-summary');
    if (snapshots.length === 0) {
      summary.style.display = 'none';
      return;
    }

    // Aggregate by app/component
    const totals = {};
    for (const s of snapshots) {
      const key = `${s.app}/${s.component}`;
      totals[key] = (totals[key] || 0) + s.count;
    }

    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10);

    const cols = [
      { key: 'appComp', label: 'App / Component' },
      { key: 'total', label: 'Total Errors', render: (r) => `<span class="font-mono">${r.total.toLocaleString()}</span>` },
    ];
    const rows = sorted.map(([appComp, total]) => ({ appComp, total }));

    summary.innerHTML = '<h3 class="subsection-title" style="border:none;margin:0;padding:0 0 0.75rem 0">Top Error Producers</h3>' +
      window.renderTable(cols, rows);
    summary.style.display = 'block';
  }
};
