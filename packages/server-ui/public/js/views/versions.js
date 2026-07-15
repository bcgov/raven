/**
 * Versions view — cross-environment version comparison.
 */
window.views = window.views || {};

window.views.versions = {
  render() {
    return `
      <div>
        <h2 class="section-title">Deployed Versions</h2>
        <form id="ver-form" class="flex gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Filter by app (optional)</label>
            ${window.createAppPicker('ver-app', true)}
          </div>
          <button type="submit" id="ver-btn" class="btn-primary">Load Versions</button>
        </form>
        <div id="ver-result" class="card">
          <p class="text-gray-500">Click "Load Versions" to compare versions across DEV/TEST/PROD.</p>
        </div>
      </div>
    `;
  },

  async init() {
    document.getElementById('ver-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const app = document.getElementById('ver-app').value.trim();
      const result = document.getElementById('ver-result');
      result.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Loading versions...</div>';

      try {
        const params = app ? `?app=${encodeURIComponent(app)}` : '';
        const res = await fetch(`/api/versions${params}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (!data.versions || data.versions.length === 0) {
          result.innerHTML = '<p class="text-gray-500">No version data found.</p>';
          return;
        }

        const mismatches = data.versions.filter(r => r.mismatch).length;
        const total = data.versions.length;

        // Build table manually so Status column can be sticky-right
        const servers = window.appData.serverConfig || [];
        let tbl = '<table class="data-table ver-table"><thead><tr>';
        tbl += '<th>App</th><th>Component</th>';
        for (const s of servers) {
          tbl += `<th>${escHtml(s.role)}</th>`;
        }
        tbl += '<th class="ver-status-col">Status</th>';
        tbl += '</tr></thead><tbody>';
        for (const r of data.versions) {
          const cls = r.mismatch ? 'mismatch-row' : '';
          const c = verAppColor(r.app);
          const badge = '<span class="app-badge" style="background:' + c.bg + ';color:' + c.fg + '">' + escHtml(r.app) + '</span>';
          const status = r.mismatch
            ? '<span class="text-yellow-400 font-semibold text-xs">⚠ Mismatch</span>'
            : '<span class="text-green-500 text-xs">✓ Match</span>';
          tbl += `<tr class="${cls}">`;
          tbl += `<td>${badge}</td>`;
          tbl += `<td>${escHtml(r.component)}</td>`;
          for (const s of servers) {
            tbl += `<td>${verCell(r.servers[s.name])}</td>`;
          }
          tbl += `<td class="ver-status-col">${status}</td>`;
          tbl += '</tr>';
        }
        tbl += '</tbody></table>';

        result.innerHTML = `
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-gray-500">${total} components — <span class="${mismatches > 0 ? 'text-yellow-400' : 'text-green-400'}">${mismatches} mismatches</span></span>
            <button type="button" id="ver-csv-btn" class="btn-csv">&#128190; Export CSV</button>
          </div>
          <div style="overflow-x:auto">
            ${tbl}
          </div>
        `;
        document.getElementById('ver-csv-btn')?.addEventListener('click', () => {
          window.exportTableToCsv(result.querySelector('table'), 'versions.csv');
        });
      } catch (err) {
        result.innerHTML = `<p class="text-red-400">${escHtml(err.message)}</p>`;
        window.showToast(err.message, 'error');
      }
    });
  }
};

function verCell(val) {
  if (!val || val === '—') return '<span class="text-gray-600">—</span>';
  return '<span class="font-mono text-sm">' + escHtml(val) + '</span>';
}

function verAppColor(name) {
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

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
