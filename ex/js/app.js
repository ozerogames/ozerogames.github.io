import { storage } from './storage.js';
import { compile, compileSegmented, buildOutputExpr } from './formula-engine.js';

// --- Constants ---

const CONFIG = {
  TOAST_DURATION: 2000,
  PREVIEW_DEBOUNCE: 300,
  FORMULA_WARN_LENGTH: 7500,
};

// --- State ---

let state = createEmptyConfig();

function createEmptyConfig() {
  return {
    id: null,
    name: '',
    columnMode: 'header',
    headers: {},
    headerOrder: [],  // track insertion order: [{name, letter}]
    startRow: 2,
    preFilter: { enabled: false, conditionLogic: 'AND', conditions: [] },
    rules: [],
    defaultOutput: ''
  };
}

function generateRuleId() {
  return 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// --- Rule Colors ---

const RULE_COLORS = [
  '#e06c75', '#e5c07b', '#61afef', '#c678dd', '#56b6c2',
  '#d19a66', '#98c379', '#be5046', '#7ec8e3', '#c8a2c8',
  '#f0a500', '#68b984', '#e57373', '#64b5f6', '#ba68c8',
];

// Map rule id → color (stable across re-renders)
const ruleColorMap = new Map();

function getRuleColor(ruleId, index) {
  if (!ruleColorMap.has(ruleId)) {
    ruleColorMap.set(ruleId, RULE_COLORS[ruleColorMap.size % RULE_COLORS.length]);
  }
  return ruleColorMap.get(ruleId);
}

function pruneRuleColors() {
  const activeIds = new Set(state.rules.map(r => r.id));
  for (const id of ruleColorMap.keys()) {
    if (!activeIds.has(id)) ruleColorMap.delete(id);
  }
}

// --- Collapse State ---

const collapsedRules = new Set();
let columnSetupCollapsed = false;

// --- Toast ---

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), CONFIG.TOAST_DURATION);
}

// --- Theme ---

function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  document.getElementById('btn-theme').innerHTML = theme === 'dark' ? '&#9788;' : '&#9790;';
}

// --- Build config from state for compilation ---

function buildConfig() {
  const headers = {};
  for (const h of state.headerOrder) {
    if (h.name && h.letter) headers[h.name] = h.letter;
  }
  return {
    columnMode: state.columnMode,
    headers,
    startRow: state.startRow,
    preFilter: state.preFilter,
    rules: state.rules,
    defaultOutput: state.defaultOutput
  };
}

// --- Column helpers ---

function getColumnOptions() {
  if (state.columnMode === 'header') {
    return state.headerOrder.filter(h => h.name).map(h => h.name);
  }
  // Letter mode: return all unique letters used
  const letters = new Set();
  for (const rule of state.rules) {
    for (const c of rule.conditions) {
      if (c.column) letters.add(c.column);
    }
  }
  return [...letters].sort();
}

function getUsedColumns() {
  const used = new Set();
  for (const rule of state.rules) {
    for (const c of rule.conditions) {
      if (c.column) used.add(c.column);
    }
    // Scan output template for {ColName} references
    const templateRefs = (rule.output || '').match(/\{([^}]+)\}/g) || [];
    for (const ref of templateRefs) {
      const inner = ref.slice(1, -1).trim();
      // Bare column ref (no parens)
      if (!inner.includes('(')) used.add(inner);
      // Function arg: period(Col) etc
      const funcMatch = inner.match(/\w+\(([^,)]+)/);
      if (funcMatch) used.add(funcMatch[1].trim());
    }
  }
  // Also check pre-filter
  if (state.preFilter?.conditions) {
    for (const c of state.preFilter.conditions) {
      if (c.column) used.add(c.column);
    }
  }
  return used;
}

// --- Render: Sidebar ---

function renderSidebar() {
  const list = document.getElementById('sidebar-list');
  const searchEl = document.getElementById('sidebar-search');
  const query = (searchEl?.value || '').toLowerCase();
  let items = storage.list();

  if (query) {
    items = items.filter(i => (i.name || '').toLowerCase().includes(query));
  }

  if (items.length === 0) {
    list.innerHTML = `<div class="empty-state">${query ? 'No matches' : 'No saved formulas'}</div>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const isActive = item.id === state.id;
    const date = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '';
    return `
      <div class="sidebar-item ${isActive ? 'active' : ''}" data-action="load-formula" data-id="${item.id}">
        <div class="sidebar-item-info">
          <div class="sidebar-item-name">${esc(item.name || 'Untitled')}</div>
          <div class="sidebar-item-date">${date}</div>
        </div>
        <button class="btn-icon" data-action="delete-formula" data-id="${item.id}" title="Delete" aria-label="Delete formula">&times;</button>
      </div>`;
  }).join('');
}

// --- Render: Column Setup ---

function renderColumnSetup() {
  const body = document.getElementById('column-setup-body');
  const isHeader = state.columnMode === 'header';

  let html = `
    <div class="setup-row">
      <div class="mode-toggle">
        <label><input type="radio" name="col-mode" value="header" ${isHeader ? 'checked' : ''} data-action="set-col-mode"> Header</label>
        <label><input type="radio" name="col-mode" value="letter" ${!isHeader ? 'checked' : ''} data-action="set-col-mode"> Letter</label>
      </div>
      <label>Start Row: <input type="number" value="${state.startRow}" min="1" data-action="set-start-row"></label>
    </div>`;

  if (isHeader) {
    const usedCols = getUsedColumns();
    html += state.headerOrder.map((h, i) => {
      const unused = h.name && !usedCols.has(h.name);
      return `
      <div class="column-row${unused ? ' column-unused' : ''}" data-header-index="${i}">
        <input type="text" value="${esc(h.name)}" placeholder="Header name" data-action="set-header-name" data-index="${i}" aria-label="Header name">
        <input type="text" value="${esc(h.letter)}" placeholder="Col" data-action="set-header-letter" data-index="${i}" maxlength="3" aria-label="Column letter">
        <button class="btn-icon" data-action="remove-header" data-index="${i}" title="Remove" aria-label="Remove column">&times;</button>
      </div>`;
    }).join('');

    html += `<button class="btn btn-sm" data-action="add-header" style="margin-top:4px">+ Add Column</button>`;
  }

  body.innerHTML = html;
}

// --- Output Preview Helper ---

function getOutputPreview(template) {
  try {
    const config = buildConfig();
    const result = buildOutputExpr(template, config);
    return esc(result);
  } catch {
    return '';
  }
}

// --- Shared: Condition Row ---

function renderConditionRow(cond, ci, prefix, ruleIdx, colOptions) {
  const ruleAttr = ruleIdx !== null ? ` data-rule="${ruleIdx}"` : '';
  const colSelect = state.columnMode === 'header'
    ? `<select data-action="${prefix}-column"${ruleAttr} data-cond="${ci}" aria-label="Column">
        <option value="">-- column --</option>
        ${colOptions.map(c => `<option value="${esc(c)}" ${cond.column === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
       </select>`
    : `<input type="text" value="${esc(cond.column)}" placeholder="Col letter" data-action="${prefix}-column"${ruleAttr} data-cond="${ci}" style="max-width:80px" aria-label="Column letter">`;

  return `
    <div class="condition-row" data-cond-index="${ci}">
      ${colSelect}
      <select data-action="${prefix}-type"${ruleAttr} data-cond="${ci}" aria-label="Condition type">
        ${conditionTypeOptions(cond.type)}
      </select>
      ${needsValue(cond.type) ? `<input type="text" value="${esc(cond.value)}" placeholder="${cond.type === 'one_of' ? 'a, b, c' : cond.compareColumn ? 'Column name' : 'Value'}" data-action="${prefix}-value"${ruleAttr} data-cond="${ci}" aria-label="Condition value">` : ''}
      ${cond.type === 'exact' ? `<button class="btn btn-sm case-toggle ${cond.caseSensitive ? 'btn-primary' : ''}" data-action="${prefix}-case"${ruleAttr} data-cond="${ci}" title="Case sensitive" aria-label="Toggle case sensitivity">Aa</button>` : ''}
      ${['exact','gt','lt','gte','lte'].includes(cond.type) ? `<button class="btn btn-sm case-toggle ${cond.compareColumn ? 'btn-primary' : ''}" data-action="${prefix}-compare"${ruleAttr} data-cond="${ci}" title="Compare to column" aria-label="Compare to column">Col</button>` : ''}
      <button class="btn-icon" data-action="${prefix}-remove"${ruleAttr} data-cond="${ci}" title="Remove condition" aria-label="Remove condition">&times;</button>
    </div>`;
}

// --- Render: Rules ---

function renderRules() {
  const container = document.getElementById('rules-container');
  const colOptions = getColumnOptions();

  if (state.rules.length === 0) {
    container.innerHTML = `
      <div class="empty-state">No rules yet. Add a rule to get started.</div>
      <div class="default-output-row">
        <label>Default output:</label>
        <input type="text" value="${esc(state.defaultOutput)}" data-action="set-default-output" placeholder='e.g. "" or {Column}'>
      </div>`;
    return;
  }

  pruneRuleColors();

  let html = state.rules.map((rule, ri) => {
    const color = getRuleColor(rule.id, ri);
    const condHtml = rule.conditions.map((cond, ci) =>
      renderConditionRow(cond, ci, 'rule-cond', ri, colOptions)
    ).join('');

    const collapsed = collapsedRules.has(rule.id);

    return `
      <div class="rule-block" data-rule-index="${ri}" style="border-left: 3px solid ${color}">
        <div class="rule-header collapsible">
          <button class="btn-icon chevron" data-action="toggle-rule-collapse" data-rule="${ri}" aria-label="Toggle collapse">${collapsed ? '&#9654;' : '&#9660;'}</button>
          <span style="color:${color};font-size:0.8rem;font-weight:700">${ri + 1}.</span>
          <input type="text" value="${esc(rule.label)}" placeholder="Rule label (optional)" data-action="set-rule-label" data-rule="${ri}" aria-label="Rule label">
          <div class="rule-actions">
            <button class="btn-icon" data-action="move-rule-up" data-rule="${ri}" title="Move up" aria-label="Move up" ${ri === 0 ? 'disabled' : ''}>&uarr;</button>
            <button class="btn-icon" data-action="move-rule-down" data-rule="${ri}" title="Move down" aria-label="Move down" ${ri === state.rules.length - 1 ? 'disabled' : ''}>&darr;</button>
            <button class="btn-icon" data-action="clone-rule" data-rule="${ri}" title="Clone rule" aria-label="Clone rule">&#9851;</button>
            <button class="btn-icon" data-action="remove-rule" data-rule="${ri}" title="Delete rule" aria-label="Delete rule">&times;</button>
          </div>
        </div>
        <div class="rule-body${collapsed ? ' collapsed' : ''}">
          <div class="conditions-section">
            <div class="conditions-header">
              <span>Conditions</span>
              <div class="logic-toggle">
                <button class="${rule.conditionLogic === 'AND' ? 'active' : ''}" data-action="set-logic" data-rule="${ri}" data-value="AND">AND</button>
                <button class="${rule.conditionLogic === 'OR' ? 'active' : ''}" data-action="set-logic" data-rule="${ri}" data-value="OR">OR</button>
              </div>
            </div>
            ${condHtml}
            <button class="btn btn-sm" data-action="add-condition" data-rule="${ri}" style="margin-top:4px">+ Add Condition</button>
          </div>
          <div class="output-row">
            <label>Output:</label>
            <input type="text" value="${esc(rule.output)}" placeholder='e.g. PPV-{period(Period)}' data-action="set-rule-output" data-rule="${ri}" aria-label="Output template">
          </div>
          ${rule.output ? `<div class="output-preview">${getOutputPreview(rule.output)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  html += `
    <div class="default-output-row">
      <label>Default output:</label>
      <input type="text" value="${esc(state.defaultOutput)}" data-action="set-default-output" placeholder='e.g. "" or {Column}'>
    </div>`;

  container.innerHTML = html;
}

function conditionTypeOptions(selected) {
  const types = [
    ['exact', 'equals'],
    ['contains', 'contains'],
    ['not_contains', 'not contains'],
    ['starts_with', 'starts with'],
    ['ends_with', 'ends with'],
    ['gt', '>'],
    ['lt', '<'],
    ['gte', '>='],
    ['lte', '<='],
    ['one_of', 'one of'],
    ['empty', 'is empty'],
    ['not_empty', 'is not empty'],
  ];
  return types.map(([val, label]) =>
    `<option value="${val}" ${selected === val ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function needsValue(type) {
  return type !== 'empty' && type !== 'not_empty';
}

// --- Render: Preview ---

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, CONFIG.PREVIEW_DEBOUNCE);
}

function renderPreview() {
  const config = buildConfig();
  const output = document.getElementById('formula-output');
  let plainFormula;

  try {
    const segments = compileSegmented(config);
    plainFormula = segments.map(s => s.text).join('');

    output.innerHTML = segments.map(seg => {
      const escaped = esc(seg.text);
      if (seg.ruleIndex >= 0 && state.rules[seg.ruleIndex]) {
        const color = getRuleColor(state.rules[seg.ruleIndex].id, seg.ruleIndex);
        return `<span style="color:${color}">${escaped}</span>`;
      }
      return escaped;
    }).join('');
  } catch (e) {
    // Try to identify which rule caused the error
    let errMsg = e.message || 'Unknown error';
    const config = buildConfig();
    for (let i = 0; i < (config.rules || []).length; i++) {
      try {
        compile({ ...config, rules: config.rules.slice(0, i + 1) });
      } catch {
        const label = config.rules[i].label || `Rule ${i + 1}`;
        errMsg = `Error in "${label}": ${e.message}`;
        break;
      }
    }
    plainFormula = errMsg;
    output.textContent = plainFormula;
    output.style.color = 'var(--danger)';
    setTimeout(() => output.style.color = '', 0);
  }

  const warning = document.getElementById('formula-warning');
  if (plainFormula.length > CONFIG.FORMULA_WARN_LENGTH) {
    warning.textContent = `Warning: Formula is ${plainFormula.length} characters (Excel limit is ~8,192)`;
    warning.style.display = '';
  } else {
    warning.style.display = 'none';
  }
}

// --- Render: All ---

function renderPreFilter() {
  const container = document.getElementById('prefilter-body');
  const pf = state.preFilter;
  const colOptions = getColumnOptions();

  let html = `
    <div class="setup-row" style="margin-bottom:8px">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" ${pf.enabled ? 'checked' : ''} data-action="toggle-prefilter">
        Enable pre-filter
      </label>
    </div>`;

  if (pf.enabled) {
    html += `
      <div class="conditions-header" style="margin-bottom:8px">
        <span>Conditions</span>
        <div class="logic-toggle">
          <button class="${pf.conditionLogic === 'AND' ? 'active' : ''}" data-action="set-pf-logic" data-value="AND">AND</button>
          <button class="${pf.conditionLogic === 'OR' ? 'active' : ''}" data-action="set-pf-logic" data-value="OR">OR</button>
        </div>
      </div>`;

    html += pf.conditions.map((cond, ci) =>
      renderConditionRow(cond, ci, 'pf-cond', null, colOptions)
    ).join('');

    html += `<button class="btn btn-sm" data-action="add-pf-condition" style="margin-top:4px">+ Add Condition</button>`;
  }

  container.innerHTML = html;
}

function renderAll() {
  renderSidebar();
  renderColumnSetup();
  renderPreFilter();
  renderRules();
  renderPreview();
  document.getElementById('formula-name').value = state.name || '';
}

// --- HTML escape ---

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- State mutations ---

function loadConfig(config) {
  state.id = config.id || null;
  state.name = config.name || '';
  state.columnMode = config.columnMode || 'header';
  state.startRow = config.startRow || 2;
  state.defaultOutput = config.defaultOutput || '';

  const pf = config.preFilter || {};
  state.preFilter = {
    enabled: !!pf.enabled,
    conditionLogic: pf.conditionLogic || 'AND',
    conditions: (pf.conditions || []).map(c => ({ ...c }))
  };

  state.rules = (config.rules || []).map(r => ({
    id: r.id || generateRuleId(),
    label: r.label || '',
    conditionLogic: r.conditionLogic || 'AND',
    conditions: (r.conditions || []).map(c => ({ ...c })),
    output: r.output || ''
  }));

  // Prefer persisted headerOrder; fall back to rebuilding from headers map
  if (Array.isArray(config.headerOrder) && config.headerOrder.length > 0) {
    state.headerOrder = config.headerOrder.map(h => ({ name: h.name || '', letter: h.letter || '' }));
  } else {
    state.headerOrder = [];
    if (config.headers) {
      for (const [name, letter] of Object.entries(config.headers)) {
        state.headerOrder.push({ name, letter });
      }
    }
  }
}

function addRule() {
  state.rules.push({
    id: generateRuleId(),
    label: '',
    conditionLogic: 'AND',
    conditions: [{ column: '', type: 'exact', value: '', caseSensitive: false }],
    output: ''
  });
  renderRules();
  schedulePreview();
}

function removeRule(index) {
  state.rules.splice(index, 1);
  renderRules();
  schedulePreview();
}

function moveRule(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= state.rules.length) return;
  [state.rules[index], state.rules[newIndex]] = [state.rules[newIndex], state.rules[index]];
  renderRules();
  schedulePreview();
}

function addCondition(ruleIndex) {
  state.rules[ruleIndex].conditions.push({
    column: '', type: 'exact', value: '', caseSensitive: false
  });
  renderRules();
  schedulePreview();
}

function removeCondition(ruleIndex, condIndex) {
  state.rules[ruleIndex].conditions.splice(condIndex, 1);
  renderRules();
  schedulePreview();
}

// --- Event Delegation ---

// Sidebar search
document.getElementById('sidebar-search').addEventListener('input', () => renderSidebar());

// Column setup collapse
document.getElementById('column-setup-header').addEventListener('click', (e) => {
  if (e.target.closest('input, button, select')) return;
  columnSetupCollapsed = !columnSetupCollapsed;
  const body = document.getElementById('column-setup-body');
  const chevron = document.querySelector('#column-setup-header .chevron');
  body.classList.toggle('collapsed', columnSetupCollapsed);
  chevron.innerHTML = columnSetupCollapsed ? '&#9654;' : '&#9660;';
});

// Sidebar
document.getElementById('sidebar').addEventListener('click', (e) => {
  const del = e.target.closest('[data-action="delete-formula"]');
  if (del) {
    e.stopPropagation();
    const id = del.dataset.id;
    if (confirm('Delete this formula?')) {
      storage.delete(id);
      if (state.id === id) {
        loadConfig(createEmptyConfig());
      }
      renderAll();
    }
    return;
  }

  const load = e.target.closest('[data-action="load-formula"]');
  if (load) {
    const id = load.dataset.id;
    const config = storage.load(id);
    if (config) {
      loadConfig(config);
      storage.setLastOpenedId(id);
      renderAll();
    }
  }
});

// New formula
document.getElementById('btn-new').addEventListener('click', () => {
  loadConfig(createEmptyConfig());
  renderAll();
});

// Paste CSV headers
document.getElementById('column-setup-body').addEventListener('paste', (e) => {
  if (state.columnMode !== 'header') return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  // Detect tab or comma separated headers
  const sep = text.includes('\t') ? '\t' : ',';
  const headers = text.split(sep).map(s => s.trim()).filter(Boolean);
  if (headers.length < 2) return; // not a CSV row, let normal paste happen
  e.preventDefault();
  state.headerOrder = headers.map((name, i) => ({
    name,
    letter: String.fromCharCode(65 + i) // A, B, C...
  }));
  renderColumnSetup();
  renderRules();
  schedulePreview();
  showToast(`Pasted ${headers.length} columns`);
});

// Column setup
document.getElementById('column-setup-body').addEventListener('input', (e) => {
  const el = e.target;
  const action = el.dataset.action;

  if (action === 'set-header-name') {
    state.headerOrder[Number(el.dataset.index)].name = el.value;
    // Don't re-render columns to keep focus, but update rules for dropdown changes
    schedulePreview();
    return;
  }
  if (action === 'set-header-letter') {
    state.headerOrder[Number(el.dataset.index)].letter = el.value.toUpperCase();
    schedulePreview();
    return;
  }
  if (action === 'set-start-row') {
    state.startRow = Math.max(1, parseInt(el.value) || 1);
    schedulePreview();
    return;
  }
});

document.getElementById('column-setup-body').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.action === 'set-col-mode') {
    const newMode = el.value;
    if (newMode !== state.columnMode) {
      if (state.headerOrder.length > 0 && state.columnMode === 'header') {
        if (!confirm('Switching to letter mode will clear header mappings. Continue?')) {
          // Revert radio
          renderColumnSetup();
          return;
        }
      }
      state.columnMode = newMode;
      if (newMode === 'letter') {
        state.headerOrder = [];
      }
      renderColumnSetup();
      renderRules();
      schedulePreview();
    }
  }
});

document.getElementById('column-setup-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  if (btn.dataset.action === 'add-header') {
    state.headerOrder.push({ name: '', letter: '' });
    renderColumnSetup();
    // Focus the new name input
    const inputs = document.querySelectorAll('[data-action="set-header-name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
    return;
  }

  if (btn.dataset.action === 'remove-header') {
    state.headerOrder.splice(Number(btn.dataset.index), 1);
    renderColumnSetup();
    renderRules(); // Update column dropdowns
    schedulePreview();
  }
});

// Pre-filter
document.getElementById('prefilter-body').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const ci = Number(btn.dataset.cond);

  switch (btn.dataset.action) {
    case 'toggle-prefilter':
      state.preFilter.enabled = btn.checked !== undefined ? btn.checked : !state.preFilter.enabled;
      renderPreFilter();
      schedulePreview();
      break;
    case 'set-pf-logic':
      state.preFilter.conditionLogic = btn.dataset.value;
      renderPreFilter();
      schedulePreview();
      break;
    case 'add-pf-condition':
      state.preFilter.conditions.push({ column: '', type: 'exact', value: '', caseSensitive: false });
      renderPreFilter();
      schedulePreview();
      break;
    case 'pf-cond-remove':
      state.preFilter.conditions.splice(ci, 1);
      renderPreFilter();
      schedulePreview();
      break;
    case 'pf-cond-case':
      state.preFilter.conditions[ci].caseSensitive = !state.preFilter.conditions[ci].caseSensitive;
      renderPreFilter();
      schedulePreview();
      break;
    case 'pf-cond-compare':
      state.preFilter.conditions[ci].compareColumn = !state.preFilter.conditions[ci].compareColumn;
      renderPreFilter();
      schedulePreview();
      break;
  }
});

document.getElementById('prefilter-body').addEventListener('change', (e) => {
  const el = e.target;
  const action = el.dataset.action;
  const ci = Number(el.dataset.cond);

  if (action === 'toggle-prefilter') {
    state.preFilter.enabled = el.checked;
    renderPreFilter();
    schedulePreview();
  } else if (action === 'pf-cond-column') {
    state.preFilter.conditions[ci].column = el.value;
    schedulePreview();
  } else if (action === 'pf-cond-type') {
    state.preFilter.conditions[ci].type = el.value;
    renderPreFilter();
    schedulePreview();
  }
});

document.getElementById('prefilter-body').addEventListener('input', (e) => {
  const el = e.target;
  const action = el.dataset.action;
  const ci = Number(el.dataset.cond);

  if (action === 'pf-cond-value') {
    state.preFilter.conditions[ci].value = el.value;
    schedulePreview();
  } else if (action === 'pf-cond-column' && el.tagName === 'INPUT') {
    state.preFilter.conditions[ci].column = el.value;
    schedulePreview();
  }
});

// Rules container
document.getElementById('rules-container').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const ri = Number(btn.dataset.rule);
  const ci = Number(btn.dataset.cond);

  switch (btn.dataset.action) {
    case 'add-condition': addCondition(ri); break;
    case 'rule-cond-remove': removeCondition(ri, ci); break;
    case 'remove-rule': removeRule(ri); break;
    case 'move-rule-up': moveRule(ri, -1); break;
    case 'move-rule-down': moveRule(ri, 1); break;
    case 'set-logic':
      state.rules[ri].conditionLogic = btn.dataset.value;
      renderRules();
      schedulePreview();
      break;
    case 'clone-rule': {
      const src = state.rules[ri];
      const clone = {
        id: generateRuleId(),
        label: src.label ? src.label + ' (copy)' : '',
        conditionLogic: src.conditionLogic,
        conditions: src.conditions.map(c => ({ ...c })),
        output: src.output
      };
      state.rules.splice(ri + 1, 0, clone);
      renderRules();
      schedulePreview();
      break;
    }
    case 'rule-cond-case':
      state.rules[ri].conditions[ci].caseSensitive = !state.rules[ri].conditions[ci].caseSensitive;
      renderRules();
      schedulePreview();
      break;
    case 'rule-cond-compare':
      state.rules[ri].conditions[ci].compareColumn = !state.rules[ri].conditions[ci].compareColumn;
      renderRules();
      schedulePreview();
      break;
    case 'toggle-rule-collapse': {
      const id = state.rules[ri].id;
      if (collapsedRules.has(id)) collapsedRules.delete(id);
      else collapsedRules.add(id);
      renderRules();
      break;
    }
  }
});

// Rules section header (Add Rule button)
document.getElementById('rules-section').querySelector('.card-header').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="add-rule"]');
  if (btn) addRule();
});

document.getElementById('rules-container').addEventListener('input', (e) => {
  const el = e.target;
  const action = el.dataset.action;
  const ri = Number(el.dataset.rule);
  const ci = Number(el.dataset.cond);

  switch (action) {
    case 'set-rule-label':
      state.rules[ri].label = el.value;
      break;
    case 'set-rule-output':
      state.rules[ri].output = el.value;
      schedulePreview();
      break;
    case 'rule-cond-value':
      state.rules[ri].conditions[ci].value = el.value;
      schedulePreview();
      break;
    case 'rule-cond-column':
      if (el.tagName === 'INPUT') {
        state.rules[ri].conditions[ci].column = el.value;
        schedulePreview();
      }
      break;
    case 'set-default-output':
      state.defaultOutput = el.value;
      schedulePreview();
      break;
  }
});

document.getElementById('rules-container').addEventListener('change', (e) => {
  const el = e.target;
  const action = el.dataset.action;
  const ri = Number(el.dataset.rule);
  const ci = Number(el.dataset.cond);

  switch (action) {
    case 'rule-cond-column':
      state.rules[ri].conditions[ci].column = el.value;
      schedulePreview();
      break;
    case 'rule-cond-type':
      state.rules[ri].conditions[ci].type = el.value;
      renderRules();
      schedulePreview();
      break;
  }
});

// Save
document.getElementById('btn-save').addEventListener('click', () => {
  const name = document.getElementById('formula-name').value.trim();
  if (!name) {
    showToast('Please enter a formula name');
    document.getElementById('formula-name').focus();
    return;
  }

  state.name = name;

  // Build headers from headerOrder
  const headers = {};
  for (const h of state.headerOrder) {
    if (h.name && h.letter) headers[h.name] = h.letter;
  }

  const config = {
    id: state.id,
    name: state.name,
    columnMode: state.columnMode,
    headers,
    headerOrder: state.headerOrder.map(h => ({ ...h })),
    startRow: state.startRow,
    rules: state.rules.map(r => ({
      id: r.id,
      label: r.label,
      conditionLogic: r.conditionLogic,
      conditions: r.conditions.map(c => ({ ...c })),
      output: r.output
    })),
    preFilter: {
      enabled: state.preFilter.enabled,
      conditionLogic: state.preFilter.conditionLogic,
      conditions: state.preFilter.conditions.map(c => ({ ...c }))
    },
    defaultOutput: state.defaultOutput,
    createdAt: state.id ? undefined : undefined // storage.save handles timestamps
  };

  storage.save(config);
  state.id = config.id; // save may generate a new id
  showToast('Formula saved');
  renderSidebar();
});

// Copy
document.getElementById('btn-copy').addEventListener('click', async () => {
  const text = document.getElementById('formula-output').textContent;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Copied to clipboard');
  }
});

// Share link
document.getElementById('btn-share').addEventListener('click', async () => {
  const config = buildConfig();
  config.name = state.name || 'Untitled';
  config.rules = state.rules;
  try {
    const json = JSON.stringify(config);
    const encoded = btoa(unescape(encodeURIComponent(json)));
    const url = window.location.origin + window.location.pathname + '#' + encoded;
    await navigator.clipboard.writeText(url);
    showToast('Share link copied');
  } catch {
    showToast('Failed to generate share link');
  }
});

// Theme
document.getElementById('btn-theme').addEventListener('click', toggleTheme);

// Export
document.getElementById('btn-export').addEventListener('click', () => {
  const json = storage.exportAll();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'excel-macro-formulas.json';
  a.click();
  URL.revokeObjectURL(url);
  const count = storage.list().length;
  showToast(`Exported ${count} formula${count !== 1 ? 's' : ''}`);
});

// Import
document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const count = storage.importAll(reader.result);
      loadConfig(createEmptyConfig());
      renderAll();
      showToast(`Imported ${count} formula${count !== 1 ? 's' : ''}`);
    } catch (err) {
      showToast('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset so same file can be imported again
});

// --- Init ---

function init() {
  initTheme();

  // Check for shared config in URL hash
  const hash = window.location.hash.slice(1);
  if (hash) {
    try {
      const json = decodeURIComponent(escape(atob(hash)));
      const config = JSON.parse(json);
      loadConfig(config);
      window.location.hash = '';
      showToast('Loaded shared formula');
      renderAll();
      return;
    } catch {
      // Invalid hash, ignore
    }
  }

  const lastId = storage.getLastOpenedId();
  if (lastId) {
    const config = storage.load(lastId);
    if (config) {
      loadConfig(config);
    }
  }

  renderAll();
}

init();
