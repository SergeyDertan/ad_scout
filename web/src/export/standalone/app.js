/* Self-contained mini-app for the exported HTML page. No imports, no build step:
 * it reads window.__EXPORT__ (= { model, header }) embedded by the web app, lets
 * the user re-filter with the SAME filters as the Responses view, pick which
 * columns to export, edit the title, and download an XLSX via the inlined SheetJS.
 *
 * The pricing/pivot helpers below MUST stay in sync with web/src/export/model.ts
 * (META_COLUMNS, buildAoa, metaValue, priceValue). The heavy lifting is already
 * baked into the embedded normalized model, so this stays small. */
(function () {
  var EXPORT = window.__EXPORT__ || {};
  var model = EXPORT.model || { rows: [], combos: [], niches: [], campaigns: [], generatedAt: '' };

  var META_COLUMNS = [
    { key: 'website', label: 'Website' },
    { key: 'email', label: 'Contact email' },
    { key: 'campaign', label: 'Campaign' },
    { key: 'canPost', label: 'Can post' },
    { key: 'received', label: 'Received' },
  ];

  var PREVIEW_LIMIT = 200;

  // ---- state ----
  var filters = { search: '', campaign: '', niche: '', canpost: '' };
  var selection = {
    meta: new Set(['website', 'email', 'campaign', 'canPost']),
    combos: new Set(model.combos.map(function (c) { return c.key; })),
    includeCanPost: false,
    numericPrices: true,
  };
  var title = EXPORT.header || 'AdScout responses export';

  var comboByKey = {};
  model.combos.forEach(function (c) { comboByKey[c.key] = c; });
  var nicheByKey = {};
  model.niches.forEach(function (n) { nicheByKey[n.key] = n; });

  // ---- helpers (mirror model.ts) ----
  function isSensitiveKey(key) {
    if (key === 'sensitive') return true;
    return !!(nicheByKey[key] && nicheByKey[key].sensitive);
  }
  // Umbrella-aware match: exact category, or the 'sensitive' umbrella, mirroring
  // offerMatchesFilter in the app.
  function cellMatchesNiche(combo, filterKey) {
    if (!filterKey) return true;
    if (combo.category === filterKey) return true;
    if (filterKey === 'sensitive') return combo.sensitive;
    if (isSensitiveKey(filterKey) && combo.category === 'sensitive') return true;
    return false;
  }

  function rowMatches(r) {
    if (filters.search && r.search.indexOf(filters.search) === -1) return false;
    if (filters.campaign && r.campaignId !== filters.campaign) return false;
    if (filters.niche || filters.canpost) {
      var keys = Object.keys(r.cells);
      var hit = keys.some(function (k) {
        var combo = comboByKey[k];
        if (!combo) return false;
        var nicheOk = cellMatchesNiche(combo, filters.niche);
        var canOk = !filters.canpost || r.cells[k].canPost === filters.canpost;
        return nicheOk && canOk;
      });
      if (!hit) return false;
    }
    return true;
  }

  function filteredRows() { return model.rows.filter(rowMatches); }

  function metaValue(r, key) {
    switch (key) {
      case 'website': return r.website;
      case 'email': return r.email;
      case 'campaign': return r.campaign;
      case 'canPost': return r.canPost;
      case 'received': return r.receivedLabel;
      default: return '';
    }
  }

  function priceValue(cell, numeric) {
    if (!cell) return '';
    if (numeric && cell.amount != null) return cell.amount;
    return cell.raw === '—' ? '' : cell.raw;
  }

  function selectedMeta() {
    return META_COLUMNS.filter(function (m) { return selection.meta.has(m.key); });
  }
  function selectedCombos() {
    return model.combos.filter(function (c) { return selection.combos.has(c.key); });
  }

  function buildAoa(rows) {
    var metaCols = selectedMeta();
    var combos = selectedCombos();
    var headerRow = metaCols.map(function (m) { return m.label; });
    combos.forEach(function (c) {
      headerRow.push(c.label);
      if (selection.includeCanPost) headerRow.push(c.label + ' — can post');
    });
    var aoa = [];
    if (title.trim()) { aoa.push([title.trim()]); aoa.push([]); }
    aoa.push(headerRow);
    rows.forEach(function (r) {
      var line = metaCols.map(function (m) { return metaValue(r, m.key); });
      combos.forEach(function (c) {
        var cell = r.cells[c.key];
        line.push(priceValue(cell, selection.numericPrices));
        if (selection.includeCanPost) line.push((cell && cell.canPost) || '');
      });
      aoa.push(line);
    });
    return aoa;
  }

  function fileStem(h) {
    var stem = h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return stem || 'adscout-export';
  }

  // ---- DOM ----
  var $ = function (id) { return document.getElementById(id); };

  function opt(value, label) {
    var o = document.createElement('option');
    o.value = value; o.textContent = label;
    return o;
  }

  function renderFilters() {
    var camp = $('campaign');
    camp.appendChild(opt('', 'All campaigns'));
    model.campaigns.forEach(function (c) { camp.appendChild(opt(c.id, c.name)); });
    if (model.campaigns.length < 2) camp.style.display = 'none';

    var niche = $('niche');
    niche.appendChild(opt('', 'All niches'));
    model.niches.forEach(function (n) {
      niche.appendChild(opt(n.key, n.label + (n.sensitive ? ' •' : '')));
    });

    var can = $('canpost');
    [['', 'Any answer'], ['yes', 'yes'], ['maybe', 'maybe'], ['no', 'no']].forEach(function (p) {
      can.appendChild(opt(p[0], p[1]));
    });
  }

  function chk(key, label, checked, onToggle) {
    var l = document.createElement('label');
    l.className = 'chk';
    var input = document.createElement('input');
    input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', function () { onToggle(input.checked); });
    l.appendChild(input);
    l.appendChild(document.createTextNode(' ' + label));
    return l;
  }

  function renderColumnPickers() {
    var metaWrap = $('metaCols');
    META_COLUMNS.forEach(function (m) {
      metaWrap.appendChild(chk(m.key, m.label, selection.meta.has(m.key), function (on) {
        on ? selection.meta.add(m.key) : selection.meta.delete(m.key);
        render();
      }));
    });
    renderComboPickers();
  }

  function renderComboPickers() {
    var wrap = $('comboCols');
    wrap.innerHTML = '';
    if (!model.combos.length) {
      wrap.textContent = 'No priced offers in this export.';
      return;
    }
    model.combos.forEach(function (c) {
      wrap.appendChild(chk(c.key, c.label, selection.combos.has(c.key), function (on) {
        on ? selection.combos.add(c.key) : selection.combos.delete(c.key);
        render();
      }));
    });
  }

  function renderTable(rows) {
    var table = $('preview');
    table.innerHTML = '';
    var metaCols = selectedMeta();
    var combos = selectedCombos();

    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    metaCols.forEach(function (m) { htr.appendChild(th(m.label)); });
    combos.forEach(function (c) {
      htr.appendChild(th(c.label));
      if (selection.includeCanPost) htr.appendChild(th(c.label + ' — can post'));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var shown = rows.slice(0, PREVIEW_LIMIT);
    shown.forEach(function (r) {
      var tr = document.createElement('tr');
      metaCols.forEach(function (m) { tr.appendChild(td(metaValue(r, m.key))); });
      combos.forEach(function (c) {
        var cell = r.cells[c.key];
        tr.appendChild(td(priceValue(cell, selection.numericPrices), true));
        if (selection.includeCanPost) tr.appendChild(td((cell && cell.canPost) || ''));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var trunc = $('trunc');
    if (rows.length > PREVIEW_LIMIT) {
      trunc.hidden = false;
      trunc.textContent = 'Showing first ' + PREVIEW_LIMIT + ' of ' + rows.length +
        ' rows — the export includes all of them.';
    } else {
      trunc.hidden = true;
    }
  }

  function th(text) { var e = document.createElement('th'); e.textContent = text; return e; }
  function td(value, numeric) {
    var e = document.createElement('td');
    var empty = value === '' || value == null;
    e.textContent = empty ? '—' : String(value);
    if (empty) e.className = 'empty';
    else if (numeric && typeof value === 'number') e.className = 'num';
    return e;
  }

  function render() {
    var rows = filteredRows();
    $('count').textContent = rows.length + ' website' + (rows.length === 1 ? '' : 's') +
      ' · ' + selectedCombos().length + ' price column' + (selectedCombos().length === 1 ? '' : 's');
    $('export').disabled = rows.length === 0 || (selectedMeta().length === 0 && selectedCombos().length === 0);
    renderTable(rows);
  }

  function doExport() {
    if (typeof XLSX === 'undefined') { alert('Spreadsheet library failed to load.'); return; }
    var rows = filteredRows();
    var aoa = buildAoa(rows);
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Responses');
    XLSX.writeFile(wb, fileStem(title) + '.xlsx');
  }

  function init() {
    $('title').value = title;
    var when = model.generatedAt ? new Date(model.generatedAt).toLocaleString() : '';
    $('meta').textContent = model.rows.length + ' responses exported' + (when ? ' on ' + when : '') +
      ' · filter and export below';
    $('foot').textContent = 'Generated by AdScout · this file works fully offline.';

    renderFilters();
    renderColumnPickers();

    $('title').addEventListener('input', function (e) { title = e.target.value; });
    $('search').addEventListener('input', function (e) { filters.search = e.target.value.trim().toLowerCase(); render(); });
    $('campaign').addEventListener('change', function (e) { filters.campaign = e.target.value; render(); });
    $('niche').addEventListener('change', function (e) { filters.niche = e.target.value; render(); });
    $('canpost').addEventListener('change', function (e) { filters.canpost = e.target.value; render(); });
    $('reset').addEventListener('click', function () {
      filters = { search: '', campaign: '', niche: '', canpost: '' };
      $('search').value = ''; $('campaign').value = ''; $('niche').value = ''; $('canpost').value = '';
      render();
    });
    $('optCanPost').addEventListener('change', function (e) { selection.includeCanPost = e.target.checked; render(); });
    $('optNumeric').addEventListener('change', function (e) { selection.numericPrices = e.target.checked; render(); });
    $('allCombos').addEventListener('click', function () {
      selection.combos = new Set(model.combos.map(function (c) { return c.key; }));
      renderComboPickers(); render();
    });
    $('noCombos').addEventListener('click', function () {
      selection.combos = new Set(); renderComboPickers(); render();
    });
    $('export').addEventListener('click', doExport);

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
