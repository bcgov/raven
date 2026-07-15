/**
 * CSV export utility — export any HTML table to a CSV file.
 */

/**
 * Export a <table> DOM element to a CSV file download.
 * @param {HTMLTableElement} tableEl - The table element to export.
 * @param {string} filename - Download filename (e.g. "versions.csv").
 */
function exportTableToCsv(tableEl, filename) {
  if (!tableEl) return;

  const rows = [];

  // Extract headers
  const headerCells = tableEl.querySelectorAll('thead th');
  if (headerCells.length > 0) {
    rows.push([...headerCells].map(th => csvEscape(th.textContent.trim())));
  }

  // Extract body rows
  const bodyRows = tableEl.querySelectorAll('tbody tr');
  for (const tr of bodyRows) {
    const cells = tr.querySelectorAll('td');
    rows.push([...cells].map(td => csvEscape(td.textContent.trim())));
  }

  // Build CSV string
  const csv = rows.map(row => row.join(',')).join('\n');

  // Trigger download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'export.csv';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  window.showToast(`Exported ${bodyRows.length} rows to ${filename}`, 'success');
}

/** Escape a cell value for CSV (handle commas, quotes, newlines). */
function csvEscape(val) {
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Add a CSV export button above a table wrapper.
 * Call this after rendering a table inside a container.
 * @param {string} containerId - The ID of the element containing the table.
 * @param {string} filename - CSV filename for download.
 */
function addCsvExportButton(containerId, filename) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const table = container.querySelector('table');
  if (!table) return;

  // Don't add duplicate buttons
  if (container.querySelector('.btn-csv')) return;

  const wrap = document.createElement('div');
  wrap.className = 'csv-export-wrap';
  wrap.innerHTML = `<button type="button" class="btn-csv">&#128190; Export CSV</button>`;
  wrap.querySelector('.btn-csv').addEventListener('click', () => {
    exportTableToCsv(table, filename);
  });

  // Insert before the table (or table wrapper)
  const tableWrap = table.closest('[style*="overflow"]') || table;
  tableWrap.parentNode.insertBefore(wrap, tableWrap);
}

window.exportTableToCsv = exportTableToCsv;
window.addCsvExportButton = addCsvExportButton;
