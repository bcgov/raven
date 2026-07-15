/**
 * Dashboard view — morning status summary with styled cards.
 */
window.views = window.views || {};

/** Deterministic color for app names. */
function appColor(name) {
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

window.views.dashboard = {
  render() {
    return `
      <div>
        <h2 class="section-title">Dashboard</h2>
        <form id="dash-form" class="flex gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Filter by app (optional)</label>
            ${window.createAppPicker('dash-app', true)}
          </div>
          <button type="submit" id="dash-btn" class="btn-primary">Load Dashboard</button>
        </form>
        <div id="dash-result" class="space-y-4">
          <p class="text-gray-500 card">Click "Load Dashboard" to fetch status across all environments.</p>
        </div>
      </div>
    `;
  },

  async init() {
    document.getElementById('dash-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const app = document.getElementById('dash-app').value.trim();
      const result = document.getElementById('dash-result');
      result.innerHTML = '<div class="flex items-center gap-2 card"><span class="spinner"></span> Loading dashboard...</div>';

      try {
        const params = app ? `?app=${encodeURIComponent(app)}` : '';
        const res = await fetch(`/api/dashboard${params}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (data.raw) {
          result.innerHTML = `<div class="card"><pre class="log-output whitespace-pre-wrap">${escapeHtml(data.raw)}</pre></div>`;
          return;
        }

        const servers = window.appData.serverConfig || [];
        let html = '';

        /** Render app/component badge column. */
        const appCompCol = {
          key: 'appComponent', label: 'App / Component', render: (r) => {
            const parts = r.appComponent.split('/');
            const c = appColor(parts[0]);
            return `<span class="app-badge" style="background:${c.bg};color:${c.fg}">${escapeHtml(parts[0])}</span> <span class="text-gray-400">/</span> <span class="text-gray-200">${escapeHtml(parts[1] || '')}</span>`;
          }
        };

        // Deployment Status
        html += '<div class="card"><div class="flex justify-between items-center"><h3 class="subsection-title" style="border:none;margin:0;padding:0">Deployment Status</h3><button type="button" class="btn-csv dash-csv" data-section="versions">&#128190; CSV</button></div>';
        if (data.versions && data.versions.length > 0) {
          const cols = [appCompCol, ...servers.map(s => ({
            key: s.name, label: `${s.role} (${s.name})`, render: (r) => escapeHtml(r.servers[s.name] || '—')
          }))];
          html += '<div style="overflow-x:auto">' + window.renderTable(cols, data.versions) + '</div>';
        } else {
          html += '<p class="text-gray-500 text-sm">No deployment data.</p>';
        }
        html += '</div>';

        // Error Summary
        html += '<div class="card"><div class="flex justify-between items-center"><h3 class="subsection-title" style="border:none;margin:0;padding:0">Error Summary (today)</h3><button type="button" class="btn-csv dash-csv" data-section="errors">&#128190; CSV</button></div>';
        if (data.errors && data.errors.length > 0) {
          const cols = [appCompCol, ...servers.map(s => ({
            key: s.name, label: s.role, render: (r) => errLink(r, s.name)
          }))];
          html += '<div style="overflow-x:auto">' + window.renderTable(cols, data.errors) + '</div>';
        } else {
          html += '<p class="text-green-400 text-sm">No errors found in today\'s logs.</p>';
        }
        html += '</div>';

        // JVM Heap
        html += '<div class="card"><div class="flex justify-between items-center"><h3 class="subsection-title" style="border:none;margin:0;padding:0">JVM Heap (running processes)</h3><button type="button" class="btn-csv dash-csv" data-section="heap">&#128190; CSV</button></div>';
        if (data.jvmHeap && data.jvmHeap.length > 0) {
          const cols = [appCompCol, ...servers.map(s => ({
            key: s.name, label: s.role, render: (r) => heapLink(r, s.name)
          }))];
          html += '<div style="overflow-x:auto">' + window.renderTable(cols, data.jvmHeap) + '</div>';
        } else {
          html += '<p class="text-gray-500 text-sm">No running Java processes.</p>';
        }
        html += '</div>';

        result.innerHTML = html;

        // Wire up CSV export buttons
        result.querySelectorAll('.dash-csv').forEach(btn => {
          btn.addEventListener('click', () => {
            const card = btn.closest('.card');
            const table = card?.querySelector('table');
            if (table) window.exportTableToCsv(table, `dashboard-${btn.dataset.section}.csv`);
          });
        });
      } catch (err) {
        result.innerHTML = `<div class="card"><p class="text-red-400">${escapeHtml(err.message)}</p></div>`;
        window.showToast(err.message, 'error');
      }
    });
  }
};

function errBadge(val) {
  if (!val || val === '—' || val === '0') return '<span class="error-badge-zero">0</span>';
  const num = parseInt(val);
  if (isNaN(num) || num === 0) return '<span class="error-badge-zero">0</span>';
  return `<span class="error-badge">${escapeHtml(val)}</span>`;
}

/**
 * Wraps an error badge in a clickable link that navigates to Log Search
 * with the server, app, component, and ERROR pattern pre-filled.
 */
function errLink(row, serverKey) {
  const val = row.servers[serverKey];
  const badge = errBadge(val);
  const num = parseInt(val);
  if (!num || num === 0) return badge;

  const parts = row.appComponent.split('/').map(s => s.trim());
  const app = parts[0] || '';
  const component = parts[1] || '';

  const params = new URLSearchParams({
    server: serverKey,
    app,
    component,
    pattern: 'ERROR|FATAL|Exception|ORA-',
    date: 'current'
  });

  return `<a href="#logs?${params.toString()}" class="err-link" title="Search ERROR logs">${badge}</a>`;
}

/**
 * Wraps a JVM heap cell value in a clickable link to the Heap page
 * with the server, app, and component pre-filled.
 */
function heapLink(row, serverKey) {
  const val = row.servers[serverKey];
  if (!val || val === '—') return '<span class="text-gray-600">—</span>';

  const parts = row.appComponent.split('/').map(s => s.trim());
  const app = parts[0] || '';
  const component = parts[1] || '';

  const params = new URLSearchParams({ server: serverKey, app, component });
  return `<a href="#heap?${params.toString()}" class="heap-link" title="View JVM Heap details">${escapeHtml(val)}</a>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
