/**
 * Health status view — shows RAVEN monitoring system health, server reachability, and collector status.
 */
window.views = window.views || {};

/** Render a ⓘ help icon with a CSS tooltip. */
function tip(text) {
  return `<span class="heap-tip">&#9432;<span class="tip-text">${escapeHtml(text)}</span></span>`;
}

window.views.health = {
  render() {
    return `
      <div>
        <h2 class="section-title">RAVEN Monitor Health</h2>
        <p class="text-sm text-gray-500 mb-4">Status of the RAVEN monitoring system itself — not the health of the monitored servers. Also available as JSON at <code class="text-xs font-mono text-gray-400">/api/health</code> for OpenShift probes.</p>
        <div id="health-result">
          <div class="flex items-center gap-2 card"><span class="spinner"></span> Checking health...</div>
        </div>
      </div>
    `;
  },

  async init() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      this.renderHealth(data);
    } catch (err) {
      document.getElementById('health-result').innerHTML =
        `<div class="card"><p class="text-red-400">${escapeHtml(err.message)}</p></div>`;
    }
  },

  renderHealth(data) {
    const statusBadge = {
      healthy:  { css: 'health-healthy',  label: 'Healthy',  dot: '&#9679;' },
      degraded: { css: 'health-degraded', label: 'Degraded', dot: '&#9679;' },
      starting: { css: 'health-starting', label: 'Starting', dot: '&#9679;' },
    };
    const badge = statusBadge[data.status] || statusBadge.starting;

    let html = `
      <div class="flex flex-wrap gap-4 mb-4">
        <div class="card card-visible flex items-center gap-3" style="min-width:200px">
          ${tip('Healthy = all configured servers are reachable via SSH. Degraded = one or more servers are unreachable. Starting = collector hasn\'t completed its first run yet.')}
          <span class="health-badge ${badge.css}">${badge.dot} ${badge.label}</span>
        </div>
        <div class="card card-visible flex items-center gap-3" style="min-width:160px">
          ${tip('How long the RAVEN Monitor process has been running since last restart.')}
          <span class="text-xs text-gray-500">Uptime</span>
          <span class="text-sm font-mono text-gray-200">${formatUptime(data.uptime)}</span>
        </div>
        <div class="card card-visible flex items-center gap-3" style="min-width:120px">
          ${tip('RAVEN Monitor application version.')}
          <span class="text-xs text-gray-500">Version</span>
          <span class="text-sm font-mono text-gray-200">${escapeHtml(data.version)}</span>
        </div>
      </div>
    `;

    // Server reachability
    html += '<div class="card card-visible mb-4"><h3 class="subsection-title" style="border:none;margin:0;padding:0 0 0.75rem 0">' +
      tip('Whether the RAVEN monitor can reach each configured server via SSH. This does NOT indicate the health of the applications running on those servers.') +
      'Server Reachability</h3>';
    html += '<div class="flex flex-wrap gap-3">';
    if (data.servers && Object.keys(data.servers).length > 0) {
      for (const [name, status] of Object.entries(data.servers)) {
        const role = window.getServerRole ? window.getServerRole(name) : name;
        const dotClass = status.reachable ? 'health-dot-ok' : 'health-dot-fail';
        const label = status.reachable ? 'Reachable' : 'Unreachable';
        const lastCheck = status.lastCheck ? formatTime(status.lastCheck) : '—';
        html += `
          <div class="health-server-card">
            <div class="health-dot ${dotClass}"></div>
            <div>
              <div class="text-sm font-semibold" style="color:var(--text-heading)">${escapeHtml(name)} <span class="text-xs text-gray-500">(${escapeHtml(role)})</span></div>
              <div class="text-xs text-gray-500">${label} &middot; Last check: ${lastCheck}</div>
            </div>
          </div>
        `;
      }
    } else {
      html += '<p class="text-gray-500 text-sm">Waiting for first collector run...</p>';
    }
    html += '</div></div>';

    // Collector status
    html += '<div class="card card-visible"><h3 class="subsection-title" style="border:none;margin:0;padding:0 0 0.75rem 0">' +
      tip('The background data collector polls each server every 30 minutes for error counts, versions, and reachability. This data feeds the Trends, Deploys, and Alerts pages.') +
      'Data Collector</h3>';
    const c = data.collector || {};
    const runningLabel = c.running
      ? '<span class="text-green-400">Running</span>'
      : '<span class="text-red-400">Stopped</span>';
    html += `
      <div class="grid grid-cols-2 gap-x-8 gap-y-2 text-sm" style="max-width:500px">
        <span class="text-gray-500">${tip('Whether the background collection loop is active.')}Status</span> <span>${runningLabel}</span>
        <span class="text-gray-500">${tip('When the collector last completed a full sweep of all servers.')}Last run</span> <span class="font-mono text-gray-300">${c.lastRun ? formatTime(c.lastRun) : '—'}</span>
        <span class="text-gray-500">${tip('When the next scheduled collection sweep will start.')}Next run</span> <span class="font-mono text-gray-300">${c.nextRun ? formatTime(c.nextRun) : '—'}</span>
        <span class="text-gray-500">${tip('Total error count snapshots in the store. Each one records the error count for one app/component/server at a point in time.')}Error snapshots</span> <span class="font-mono text-gray-300">${c.errorSnapshotCount ?? 0}</span>
        <span class="text-gray-500">${tip('Total version change records. A record is only created when a version actually changes, not for every poll.')}Version snapshots</span> <span class="font-mono text-gray-300">${c.versionSnapshotCount ?? 0}</span>
      </div>
    `;
    html += '</div>';

    document.getElementById('health-result').innerHTML = html;
  }
};

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
