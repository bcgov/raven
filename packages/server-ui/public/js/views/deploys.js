/**
 * Deployment timeline view — shows version changes with real dates from server filesystem.
 */
window.views = window.views || {};

/** Render a ⓘ help icon with a CSS tooltip. */
function tip(text) {
  return `<span class="heap-tip">&#9432;<span class="tip-text">${escapeHtml(text)}</span></span>`;
}

window.views.deploys = {
  render() {
    return `
      <div>
        <h2 class="section-title">Deployment Timeline</h2>
        <form id="deploys-form" class="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">${tip('Filter by server environment. Querying fewer servers is faster.')}Server</label>
            ${window.createServerPicker('deploys-server', true)}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">${tip('Filter by application name.')}App (optional)</label>
            ${window.createAppPicker('deploys-app', true)}
          </div>
          <button type="submit" class="btn-primary">Load Timeline</button>
          <button type="button" id="deploys-csv" class="btn-csv" style="display:none">&#128190; CSV</button>
        </form>
        <div id="deploys-result">
          <p class="text-gray-500 card">Click "Load Timeline" to see deployment history from the server filesystem.</p>
        </div>
      </div>
    `;
  },

  init() {
    document.getElementById('deploys-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.loadTimeline();
    });
  },

  async loadTimeline() {
    const server = document.getElementById('deploys-server').value.trim();
    const app = document.getElementById('deploys-app').value.trim();
    const result = document.getElementById('deploys-result');
    result.innerHTML = '<div class="flex items-center gap-2 card"><span class="spinner"></span> Querying server filesystem...</div>';

    const params = new URLSearchParams();
    if (server) params.set('server', server);
    if (app) params.set('app', app);

    try {
      const res = await fetch(`/api/deploys?${params}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (!data.entries || data.entries.length === 0) {
        result.innerHTML = '<p class="text-gray-500 card">No deployment data found.</p>';
        document.getElementById('deploys-csv').style.display = 'none';
        return;
      }

      this.renderTimeline(data.entries);

      // Show CSV button
      const csvBtn = document.getElementById('deploys-csv');
      csvBtn.style.display = 'inline-flex';
      csvBtn.onclick = () => this.exportCsv(data.entries);
    } catch (err) {
      result.innerHTML = `<div class="card"><p class="text-red-400">${escapeHtml(err.message)}</p></div>`;
      window.showToast(err.message, 'error');
    }
  },

  renderTimeline(entries) {
    let html = '<div class="card"><div class="timeline">';

    for (const entry of entries) {
      const role = getRole(entry.server);
      const dotClass = `timeline-dot-${role.toLowerCase()}`;
      const badgeClass = `env-badge-${role.toLowerCase()}`;
      const date = formatDateTime(entry.deployedAt);
      const prev = entry.previousVersion
        ? escapeHtml(entry.previousVersion)
        : '<span class="text-gray-500 italic">initial</span>';
      const ver = escapeHtml(entry.version);
      const currentTag = entry.isCurrent
        ? ' <span class="text-xs text-green-400 font-semibold">● current</span>'
        : '';

      html += `
        <div class="timeline-item">
          <div class="timeline-dot ${dotClass}"></div>
          <div>
            <div class="timeline-date">${date}</div>
            <div class="timeline-title">${escapeHtml(entry.app)} / ${escapeHtml(entry.component)}${currentTag}</div>
            <div class="timeline-detail">
              <span class="env-badge ${badgeClass}">${escapeHtml(role)}</span>
              ${prev} &#8594; <strong>${ver}</strong>
              <span class="text-gray-500">on ${escapeHtml(entry.server)}</span>
            </div>
          </div>
        </div>
      `;
    }

    html += '</div></div>';
    document.getElementById('deploys-result').innerHTML = html;
  },

  exportCsv(entries) {
    const header = 'Deployed At,App,Component,Server,Role,Previous Version,New Version,Is Current\n';
    const rows = entries.map(e => {
      const role = getRole(e.server);
      return [
        e.deployedAt,
        csvEscape(e.app),
        csvEscape(e.component),
        csvEscape(e.server),
        csvEscape(role),
        csvEscape(e.previousVersion || ''),
        csvEscape(e.version),
        e.isCurrent ? 'yes' : 'no',
      ].join(',');
    });
    const blob = new Blob([header + rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'deployments.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
};

function getRole(serverName) {
  return window.getServerRole ? window.getServerRole(serverName) : serverName;
}

function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return iso; }
}

function csvEscape(val) {
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
