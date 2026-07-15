/**
 * Alert management view — rules CRUD, history, and real-time SSE notifications.
 */
window.views = window.views || {};

/** Render a ⓘ help icon with a CSS tooltip. */
function tip(text) {
  return `<span class="heap-tip">&#9432;<span class="tip-text">${escapeHtml(text)}</span></span>`;
}

window.views.alerts = {
  _eventSource: null,

  render() {
    return `
      <div>
        <h2 class="section-title">Threshold Alerts</h2>

        <!-- Add Rule Form -->
        <div class="card card-visible mb-4">
          <h3 class="subsection-title" style="border:none;margin:0;padding:0 0 0.75rem 0">Add Rule</h3>
          <form id="alert-form" class="flex flex-wrap gap-3 items-end">
            <div>
              <label class="text-xs text-gray-500 block mb-1">${tip('Heap Usage: triggers when JVM heap exceeds the threshold percentage. Error Count: triggers when total errors exceed the threshold within the time window.')}Type</label>
              <select id="alert-type" class="form-select">
                <option value="heap">Heap Usage (%)</option>
                <option value="errors">Error Count</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">${tip('Which server environment to monitor.')}Server</label>
              ${window.createServerPicker('alert-server')}
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">${tip('The application to monitor (e.g. RRS, DMS, CIRRAS).')}App</label>
              ${window.createAppPicker('alert-app')}
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">${tip('The specific component of the app (e.g. rrs-api, dms-web).')}Component</label>
              ${window.createComponentPicker('alert-comp', window.appData.apps[0] || '')}
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">${tip('For heap: percentage (e.g. 90 means alert at 90% heap used). For errors: total error count (e.g. 50 means alert when 50+ errors in the time window).')}Threshold</label>
              <input type="number" id="alert-threshold" class="form-input" style="width:80px" value="90" min="1">
            </div>
            <div id="alert-window-wrap">
              <label class="text-xs text-gray-500 block mb-1">${tip('Time window for counting errors. Example: "1 hour" means alert fires if errors exceed the threshold within the last hour. Only applies to Error Count alerts.')}Window</label>
              <select id="alert-window" class="form-select">
                <option value="1h">1 hour</option>
                <option value="6h">6 hours</option>
                <option value="24h">24 hours</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">${tip('How to receive notifications. Webhook sends a JSON POST to a URL (e.g. Slack/Teams incoming webhook). Email sends a notification to the specified address.')}Notify via</label>
              <select id="alert-notify-type" class="form-select">
                <option value="none">In-app only</option>
                <option value="webhook">Webhook (Slack/Teams)</option>
                <option value="email">Email</option>
              </select>
            </div>
            <div id="alert-webhook-wrap" style="display:none">
              <label class="text-xs text-gray-500 block mb-1">Webhook URL</label>
              <input type="url" id="alert-webhook" class="form-input" placeholder="https://hooks.slack.com/..." style="width:250px">
            </div>
            <div id="alert-email-wrap" style="display:none">
              <label class="text-xs text-gray-500 block mb-1">Email address</label>
              <div style="display:flex;gap:0.5rem;align-items:center">
                <input type="email" id="alert-email" class="form-input" placeholder="user@gov.bc.ca" style="width:250px">
                <button type="button" id="alert-test-email" class="btn-secondary-sm" title="Send a test email to verify SMTP">Test</button>
              </div>
            </div>
            <button type="submit" class="btn-primary">Add Rule</button>
          </form>
        </div>

        <!-- Rules Table -->
        <div class="card card-visible mb-4">
          <h3 class="subsection-title" style="border:none;margin:0;padding:0 0 0.75rem 0">${tip('Active alert rules. Toggle the switch to enable/disable a rule without deleting it.')}Active Rules</h3>
          <div id="alert-rules"><p class="text-gray-500 text-sm">Loading rules...</p></div>
        </div>

        <!-- Alert History -->
        <div class="card card-visible">
          <h3 class="subsection-title" style="border:none;margin:0;padding:0 0 0.75rem 0">${tip('Log of all alerts that have fired. Each rule has a 30-minute cooldown to prevent duplicate notifications.')}Alert History</h3>
          <div id="alert-history"><p class="text-gray-500 text-sm">Loading history...</p></div>
        </div>
      </div>
    `;
  },

  init() {
    const typeEl = document.getElementById('alert-type');
    const windowWrap = document.getElementById('alert-window-wrap');
    const notifyTypeEl = document.getElementById('alert-notify-type');
    const webhookWrap = document.getElementById('alert-webhook-wrap');
    const emailWrap = document.getElementById('alert-email-wrap');

    // Type change: show/hide window field
    typeEl.addEventListener('change', () => {
      windowWrap.style.display = typeEl.value === 'errors' ? 'block' : 'none';
    });
    // Default: heap selected, hide window
    windowWrap.style.display = 'none';

    // Notify type change: show/hide webhook/email fields
    notifyTypeEl.addEventListener('change', () => {
      webhookWrap.style.display = notifyTypeEl.value === 'webhook' ? 'block' : 'none';
      emailWrap.style.display = notifyTypeEl.value === 'email' ? 'block' : 'none';
    });

    // Test email button
    document.getElementById('alert-test-email').addEventListener('click', async () => {
      const email = document.getElementById('alert-email').value.trim();
      if (!email) {
        window.showToast('Enter an email address first', 'error');
        return;
      }
      const btn = document.getElementById('alert-test-email');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const res = await fetch('/api/alerts/test-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json();
        if (data.ok) {
          window.showToast(`Test email sent to ${email}`, 'success');
        } else {
          window.showToast(data.error || 'Failed to send test email', 'error');
        }
      } catch (err) {
        window.showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
      }
    });

    // App -> component cascade
    document.getElementById('alert-app').addEventListener('change', (e) => {
      window.updateComponentPicker('alert-comp', e.target.value);
    });

    // Form submit
    document.getElementById('alert-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.createRule();
    });

    this.loadRules();
    this.loadHistory();
    this.startAlertStream();
  },

  async createRule() {
    const notifyType = document.getElementById('alert-notify-type').value;
    const body = {
      type: document.getElementById('alert-type').value,
      server: document.getElementById('alert-server').value,
      app: document.getElementById('alert-app').value,
      component: document.getElementById('alert-comp').value,
      threshold: parseInt(document.getElementById('alert-threshold').value),
    };

    if (body.type === 'errors') {
      body.window = document.getElementById('alert-window').value;
    }

    if (notifyType === 'webhook') {
      body.webhookUrl = document.getElementById('alert-webhook').value.trim();
      if (!body.webhookUrl) {
        window.showToast('Webhook URL is required', 'error');
        return;
      }
    } else if (notifyType === 'email') {
      body.notifyEmail = document.getElementById('alert-email').value.trim();
      if (!body.notifyEmail) {
        window.showToast('Email address is required', 'error');
        return;
      }
    }

    try {
      const res = await fetch('/api/alerts/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create rule');
      window.showToast('Alert rule created', 'success');
      this.loadRules();
    } catch (err) {
      window.showToast(err.message, 'error');
    }
  },

  async loadRules() {
    try {
      const res = await fetch('/api/alerts/rules');
      const rules = await res.json();
      this.renderRules(rules);
    } catch (err) {
      document.getElementById('alert-rules').innerHTML =
        `<p class="text-red-400 text-sm">${escapeHtml(err.message)}</p>`;
    }
  },

  renderRules(rules) {
    const container = document.getElementById('alert-rules');
    if (!rules || rules.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm">No alert rules configured.</p>';
      return;
    }

    const cols = [
      { key: 'type', label: 'Type', render: (r) => `<span class="text-xs font-mono">${r.type.toUpperCase()}</span>` },
      { key: 'server', label: 'Server', render: (r) => {
        const role = window.getServerRole ? window.getServerRole(r.server) : r.server;
        return `${escapeHtml(r.server)} <span class="text-xs text-gray-500">(${escapeHtml(role)})</span>`;
      }},
      { key: 'target', label: 'App / Component', render: (r) => `${escapeHtml(r.app)} / ${escapeHtml(r.component)}` },
      { key: 'threshold', label: 'Threshold', render: (r) => {
        const unit = r.type === 'heap' ? '%' : '';
        return `<span class="font-mono">${r.threshold}${unit}</span>`;
      }},
      { key: 'notify', label: 'Notification', render: (r) => {
        if (r.notifyEmail) {
          return `<span class="text-xs">&#9993; ${escapeHtml(r.notifyEmail)}</span>`;
        }
        if (r.webhookUrl) {
          const short = r.webhookUrl.length > 25 ? r.webhookUrl.slice(0, 25) + '...' : r.webhookUrl;
          return `<span class="text-xs font-mono" title="${escapeHtml(r.webhookUrl)}">&#128279; ${escapeHtml(short)}</span>`;
        }
        return '<span class="text-xs text-gray-500">In-app only</span>';
      }},
      { key: 'enabled', label: 'Enabled', render: (r) =>
        `<div class="toggle-switch ${r.enabled ? 'active' : ''}" data-rule-id="${r.id}" data-action="toggle"></div>`
      },
      { key: 'actions', label: '', render: (r) =>
        `<button class="btn-danger-sm" data-rule-id="${r.id}" data-action="delete" title="Delete rule">&#10005;</button>`
      },
    ];

    container.innerHTML = '<div style="overflow-x:auto">' + window.renderTable(cols, rules) + '</div>';

    // Wire up toggle and delete handlers
    container.querySelectorAll('[data-action="toggle"]').forEach(el => {
      el.addEventListener('click', () => this.toggleRule(el.dataset.ruleId, !el.classList.contains('active')));
    });
    container.querySelectorAll('[data-action="delete"]').forEach(el => {
      el.addEventListener('click', () => this.deleteRule(el.dataset.ruleId));
    });
  },

  async toggleRule(id, enabled) {
    try {
      await fetch(`/api/alerts/rules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      this.loadRules();
    } catch (err) {
      window.showToast(err.message, 'error');
    }
  },

  async deleteRule(id) {
    try {
      const res = await fetch(`/api/alerts/rules/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      window.showToast('Rule deleted', 'success');
      this.loadRules();
    } catch (err) {
      window.showToast(err.message, 'error');
    }
  },

  async loadHistory() {
    try {
      const res = await fetch('/api/alerts/history?limit=50');
      const events = await res.json();
      this.renderHistory(events);
    } catch (err) {
      document.getElementById('alert-history').innerHTML =
        `<p class="text-red-400 text-sm">${escapeHtml(err.message)}</p>`;
    }
  },

  renderHistory(events) {
    const container = document.getElementById('alert-history');
    if (!events || events.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm">No alerts fired yet.</p>';
      return;
    }

    let html = '';
    for (const e of events) {
      const time = formatTime(e.ts);
      html += `
        <div class="alert-log-line">
          <div class="alert-log-dot"></div>
          <span class="text-xs text-gray-500 font-mono" style="min-width:130px">${time}</span>
          <span class="text-sm" style="color:var(--text-primary)">${escapeHtml(e.message)}</span>
        </div>
      `;
    }
    container.innerHTML = html;
  },

  startAlertStream() {
    if (this._eventSource) return;
    this._eventSource = new EventSource('/api/alerts/stream');
    this._eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        window.showToast(event.message, 'error');
        // Reload history to show the new event
        this.loadHistory();
      } catch { /* ignore parse errors */ }
    };
  },

  stopAlertStream() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
  }
};

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
