const STORAGE_KEY = 'excel-macro-formulas';
const LIBRARY_KEY = 'excel-macro-rule-library';

function _read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { formulas: {}, lastOpenedId: null };
    const data = JSON.parse(raw);
    if (!data || typeof data.formulas !== 'object') {
      return { formulas: {}, lastOpenedId: null };
    }
    return data;
  } catch {
    return { formulas: {}, lastOpenedId: null };
  }
}

function _write(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function generateId() {
  return 'f_' + Date.now();
}

export const storage = {
  list() {
    const data = _read();
    return Object.values(data.formulas)
      .map(f => ({ id: f.id, name: f.name, updatedAt: f.updatedAt }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },

  load(id) {
    const data = _read();
    return data.formulas[id] || null;
  },

  save(config) {
    const data = _read();
    if (!config.id) {
      config.id = generateId();
      config.createdAt = new Date().toISOString();
    }
    config.updatedAt = new Date().toISOString();
    data.formulas[config.id] = config;
    data.lastOpenedId = config.id;
    _write(data);
  },

  delete(id) {
    const data = _read();
    delete data.formulas[id];
    if (data.lastOpenedId === id) {
      data.lastOpenedId = null;
    }
    _write(data);
  },

  getLastOpenedId() {
    return _read().lastOpenedId;
  },

  setLastOpenedId(id) {
    const data = _read();
    data.lastOpenedId = id;
    _write(data);
  },

  exportAll() {
    return JSON.stringify(_read(), null, 2);
  },

  // --- Rule Library ---

  listLibraryRules() {
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return Object.values(data.rules || {})
        .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    } catch {
      return [];
    }
  },

  saveLibraryRule(rule) {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(LIBRARY_KEY)) || { rules: {} };
    } catch {
      data = { rules: {} };
    }
    if (!rule.id) rule.id = 'lr_' + Date.now();
    rule.savedAt = new Date().toISOString();
    data.rules[rule.id] = rule;
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
    return rule.id;
  },

  deleteLibraryRule(id) {
    try {
      const data = JSON.parse(localStorage.getItem(LIBRARY_KEY)) || { rules: {} };
      delete data.rules[id];
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
    } catch { /* ignore */ }
  },

  importAll(json) {
    const data = JSON.parse(json);
    if (!data || typeof data.formulas !== 'object') {
      throw new Error('Invalid import data');
    }
    const cleaned = { formulas: {}, lastOpenedId: data.lastOpenedId || null };
    for (const [id, f] of Object.entries(data.formulas)) {
      if (!f || !f.id) continue;
      cleaned.formulas[id] = {
        id: f.id,
        name: f.name || 'Untitled',
        createdAt: f.createdAt || new Date().toISOString(),
        updatedAt: f.updatedAt || new Date().toISOString(),
        columnMode: f.columnMode || 'header',
        headers: f.headers || {},
        headerOrder: f.headerOrder || null,
        startRow: f.startRow || 2,
        rules: Array.isArray(f.rules) ? f.rules : [],
        preFilter: f.preFilter || null,
        defaultOutput: f.defaultOutput || ''
      };
    }
    _write(cleaned);
    return Object.keys(cleaned.formulas).length;
  }
};
