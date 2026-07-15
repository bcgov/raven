/**
 * Diff viewer — renders unified diff output with syntax highlighting.
 * Filters out SSH session noise that may leak through.
 */

/** Lines matching these patterns are SSH noise, not diff content. */
const NOISE_PATTERNS = [
  /___CONFIG_(BEGIN|END|NOTFOUND)___/,
  /^\[.*@.*\]\$\s*/,
  /^\[sudo\]\s*password/,
  /^exit$/,
  /^logout$/,
  /^Connection to .* closed/,
  /^spawn\s+ssh/,
  /^\*\*\s*(WARNING|This session)/,
  /^\*\*\s*The server may/,
  /^Last login:/,
  /password:\s*$/i,
];

function isNoiseLine(line) {
  const trimmed = line.trim();
  return NOISE_PATTERNS.some(p => p.test(trimmed));
}

export function renderDiff(diffText) {
  if (!diffText || !diffText.trim()) {
    return '<p class="text-gray-500">No differences found — configs are identical.</p>';
  }

  const lines = diffText.split('\n');
  // Check if there's any actual diff content (lines starting with +/- or @@)
  const hasDiffContent = lines.some(l =>
    (l.startsWith('+') || l.startsWith('-') || l.startsWith('@@')) && !isNoiseLine(l)
  );

  let html = '<pre class="log-output bg-gray-900 rounded-lg p-4 overflow-x-auto">';
  for (const line of lines) {
    // Skip noise lines in diff output
    if (isNoiseLine(line)) continue;

    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      html += `<span class="diff-hdr">${escapeHtml(line)}</span>\n`;
    } else if (line.startsWith('+')) {
      html += `<span class="diff-add">${escapeHtml(line)}</span>\n`;
    } else if (line.startsWith('-')) {
      html += `<span class="diff-del">${escapeHtml(line)}</span>\n`;
    } else {
      html += `${escapeHtml(line)}\n`;
    }
  }
  html += '</pre>';

  // If after filtering there's no real diff content, show a clean message
  if (!hasDiffContent) {
    const warningLines = lines.filter(l => l.includes('Warning:') || l.includes('not found') || l.includes('Not enough') || l.includes('identical'));
    if (warningLines.length > 0) {
      return `<div class="text-gray-400 text-sm space-y-1">${warningLines.map(l => `<p>${escapeHtml(l.trim())}</p>`).join('')}</div>`;
    }
    return '<p class="text-green-400">No differences found — configs are identical.</p>';
  }

  return html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

window.renderDiff = renderDiff;
