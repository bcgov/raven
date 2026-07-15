/**
 * Log Search view — search remote application logs with structured rendering.
 */
window.views = window.views || {};

window.views.logs = {
  render() {
    const firstApp = window.appData.apps[0] || '';
    const today = new Date().toISOString().slice(0, 10);
    return `
      <div>
        <h2 class="section-title">Log Search</h2>
        <form id="log-form" class="mb-4">
          <!-- Row 1: Server, App, Component -->
          <div class="flex flex-wrap gap-3 items-end mb-3">
            <div>
              <label class="text-xs text-gray-500 block mb-1">Server</label>
              ${window.createServerPicker('log-server')}
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">App</label>
              ${window.createAppPicker('log-app')}
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Component</label>
              ${window.createComponentPicker('log-comp', firstApp)}
            </div>
          </div>
          <!-- Row 2: Pattern, Log Type, Date -->
          <div class="flex flex-wrap gap-3 items-end mb-3">
            <div>
              <label class="text-xs text-gray-500 block mb-1">Pattern</label>
              <select id="log-pattern-select" class="form-select">
                <option value="ERROR|FATAL|Exception|ORA-">All Errors</option>
                <option value="ERROR">ERROR</option>
                <option value="WARN">WARN</option>
                <option value="INFO">INFO</option>
                <option value="DEBUG">DEBUG</option>
                <option value="FATAL">FATAL</option>
                <option value="ORA-">ORA-</option>
                <option value="Exception">Exception</option>
                <option value=".*">All (.*)</option>
                <option value="__custom__">Custom...</option>
              </select>
            </div>
            <div id="log-custom-wrap" style="display:none">
              <label class="text-xs text-gray-500 block mb-1">Custom pattern</label>
              <input id="log-pattern-custom" class="form-input w-40" placeholder="e.g. NullPointer">
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Log Type</label>
              <select id="log-type" class="form-select">
                <option value="app">app</option>
                <option value="catalina">catalina</option>
                <option value="access">access</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Date</label>
              <select id="log-date-mode" class="form-select">
                <option value="current">Current log</option>
                <option value="today">Today</option>
                <option value="pick">Pick date</option>
                <option value="range">Date range</option>
              </select>
            </div>
            <div id="log-date-wrap" style="display:none">
              <label class="text-xs text-gray-500 block mb-1">Date</label>
              <input id="log-date-picker" type="date" class="form-input" value="${today}" max="${today}">
            </div>
            <div id="log-range-wrap" style="display:none" class="flex gap-2 items-end">
              <div>
                <label class="text-xs text-gray-500 block mb-1">From</label>
                <input id="log-date-from" type="date" class="form-input" max="${today}">
              </div>
              <div>
                <label class="text-xs text-gray-500 block mb-1">To</label>
                <input id="log-date-to" type="date" class="form-input" value="${today}" max="${today}">
              </div>
            </div>
          </div>
          <!-- Row 3: Max lines, Context, Submit -->
          <div class="flex flex-wrap gap-3 items-end">
            <div>
              <label class="text-xs text-gray-500 block mb-1">Max lines</label>
              <input id="log-lines" class="form-input w-20" type="number" value="100" min="1" max="500">
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Context</label>
              <input id="log-ctx" class="form-input w-16" type="number" value="0" min="0" max="10">
            </div>
            <button type="submit" id="log-btn" class="btn-primary">Search</button>
          </div>
        </form>
        <div id="log-result" class="card">
          <p class="text-gray-500">Select app/component, choose a pattern, and click "Search" to grep remote logs.</p>
        </div>
      </div>
    `;
  },

  async init(params) {
    document.getElementById('log-app').addEventListener('change', (e) => {
      window.updateComponentPicker('log-comp', e.target.value);
    });

    document.getElementById('log-pattern-select').addEventListener('change', (e) => {
      document.getElementById('log-custom-wrap').style.display =
        e.target.value === '__custom__' ? 'block' : 'none';
    });

    document.getElementById('log-date-mode').addEventListener('change', (e) => {
      const mode = e.target.value;
      document.getElementById('log-date-wrap').style.display = mode === 'pick' ? 'block' : 'none';
      document.getElementById('log-range-wrap').style.display = mode === 'range' ? 'flex' : 'none';
    });

    document.getElementById('log-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const server = document.getElementById('log-server').value;
      const app = document.getElementById('log-app').value.trim();
      const component = document.getElementById('log-comp').value.trim();
      const patternSelect = document.getElementById('log-pattern-select').value;
      const patternCustom = document.getElementById('log-pattern-custom').value.trim();
      const pattern = patternSelect === '__custom__' ? patternCustom : patternSelect;
      const logType = document.getElementById('log-type').value;
      const dateMode = document.getElementById('log-date-mode').value;
      const datePicker = document.getElementById('log-date-picker').value;
      const maxLines = document.getElementById('log-lines').value;
      const context = document.getElementById('log-ctx').value;

      if (!app || !component || !pattern) {
        window.showToast('App, component, and pattern are required', 'error');
        return;
      }

      const result = document.getElementById('log-result');
      result.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Searching logs...</div>';

      try {
        const params = new URLSearchParams({
          server, app, component, pattern, logType, maxLines, context
        });

        if (dateMode === 'today') {
          params.set('date', 'today');
        } else if (dateMode === 'pick' && datePicker) {
          params.set('date', datePicker);
        } else if (dateMode === 'range') {
          const dateFrom = document.getElementById('log-date-from').value;
          const dateTo = document.getElementById('log-date-to').value;
          if (!dateFrom || !dateTo) {
            window.showToast('Select both From and To dates for range search', 'error');
            return;
          }
          if (dateFrom > dateTo) {
            window.showToast('From date must be before To date', 'error');
            return;
          }
          params.set('dateFrom', dateFrom);
          params.set('dateTo', dateTo);
        }

        const res = await fetch(`/api/logs?${params}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (!data.lines || data.lines.length === 0) {
          result.innerHTML = '<p class="text-gray-500">No matches found.</p>';
          return;
        }

        // Build download URL from current form state
        const dlParams = new URLSearchParams({ server, app, component, logType });
        if (dateMode === 'today') {
          dlParams.set('date', 'today');
        } else if (dateMode === 'pick' && datePicker) {
          dlParams.set('date', datePicker);
        }
        const dlUrl = `/api/logs/download?${dlParams}`;

        result.innerHTML = `
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-gray-500">${data.lines.length} lines</span>
            <div class="flex gap-2">
              <button type="button" id="log-export-btn" class="btn-csv">&#128190; Export CSV</button>
              <a href="${dlUrl}" class="btn-csv" title="Download full log file">&#11015; Download Log</a>
            </div>
          </div>
          <div id="log-lines-wrap" class="bg-gray-900 rounded-lg p-3 overflow-x-auto max-h-[600px] overflow-y-auto" style="background:var(--bg-log-output)">
            ${renderLogLines(data.lines, pattern)}
          </div>
        `;

        // Wire up CSV export for log lines
        document.getElementById('log-export-btn')?.addEventListener('click', () => {
          const csvRows = [['Line', 'Timestamp', 'Level', 'Message'].join(',')];
          const logReCsv = /^(\d+):(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\s+(.+)$/;
          for (const line of data.lines) {
            const m = line.match(logReCsv);
            if (m) {
              csvRows.push([m[1], m[2], m[3], '"' + m[4].replace(/"/g, '""') + '"'].join(','));
            } else {
              csvRows.push(['', '', '', '"' + line.replace(/"/g, '""') + '"'].join(','));
            }
          }
          const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${server}-${app}-${component}-logs.csv`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          window.showToast('Exported log results to CSV', 'success');
        });
      } catch (err) {
        result.innerHTML = `<p class="text-red-400">${escapeHtml(err.message)}</p>`;
        window.showToast(err.message, 'error');
      }
    });

    // Pre-fill form from URL params (e.g. from dashboard error link)
    // Must be AFTER event listeners are registered so auto-submit works
    if (params) {
      if (params.server) document.getElementById('log-server').value = params.server;
      if (params.app) {
        document.getElementById('log-app').value = params.app;
        window.updateComponentPicker('log-comp', params.app);
        // Wait a tick for component picker to populate
        await new Promise(r => setTimeout(r, 0));
      }
      if (params.component) document.getElementById('log-comp').value = params.component;
      if (params.pattern) {
        const sel = document.getElementById('log-pattern-select');
        const match = [...sel.options].find(o => o.value === params.pattern);
        if (match) {
          sel.value = params.pattern;
        } else {
          sel.value = '__custom__';
          document.getElementById('log-custom-wrap').style.display = 'block';
          document.getElementById('log-pattern-custom').value = params.pattern;
        }
      }
      if (params.dateFrom && params.dateTo) {
        document.getElementById('log-date-mode').value = 'range';
        document.getElementById('log-range-wrap').style.display = 'flex';
        document.getElementById('log-date-from').value = params.dateFrom;
        document.getElementById('log-date-to').value = params.dateTo;
      } else if (params.date) {
        if (params.date === 'today') {
          document.getElementById('log-date-mode').value = 'today';
        } else if (params.date === 'current') {
          document.getElementById('log-date-mode').value = 'current';
        } else {
          document.getElementById('log-date-mode').value = 'pick';
          document.getElementById('log-date-wrap').style.display = 'block';
          document.getElementById('log-date-picker').value = params.date;
        }
      }

      // Auto-submit if we have enough info
      if (params.app && params.component && params.pattern) {
        document.getElementById('log-form').dispatchEvent(new Event('submit'));
      }
    }
  }
};

function renderLogLines(lines, pattern) {
  const escapedPat = escapeHtml(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patRe = escapedPat && escapedPat !== '\\.' && escapedPat !== '\\.\\*'
    ? new RegExp(`(${escapedPat})`, 'gi')
    : null;

  const logRe = /^(\d+):(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(ERROR|WARN|INFO|DEBUG|FATAL|TRACE)\s+(.+)$/;

  let html = '';
  for (const line of lines) {
    const m = line.match(logRe);
    if (m) {
      const [, lineNo, ts, level, msg] = m;
      const levelLower = level.toLowerCase();
      const escapedMsg = highlightPattern(escapeHtml(msg), patRe);
      html += `<div class="log-line">
        <span class="log-lineno">${lineNo}</span>
        <span class="log-ts">${escapeHtml(ts)}</span>
        <span class="log-level log-level-${levelLower}">${level}</span>
        <span class="log-msg">${escapedMsg}</span>
      </div>`;
    } else {
      const escaped = highlightPattern(escapeHtml(line), patRe);
      html += `<div class="log-line">
        <span class="log-lineno"></span>
        <span class="log-msg" style="color:#6b7280">${escaped}</span>
      </div>`;
    }
  }
  return html;
}

function highlightPattern(escaped, patRe) {
  if (!patRe) return escaped;
  return escaped.replace(patRe, '<span class="log-match">$1</span>');
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
