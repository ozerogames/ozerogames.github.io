// formula-engine.js — Pure-function Excel formula compiler

function escapeExcel(str) {
  return str.replace(/"/g, '""');
}

function quote(val) {
  return '"' + escapeExcel(val) + '"';
}

function isNumeric(val) {
  return val !== '' && !isNaN(Number(val));
}

function numOrQuote(val) {
  return isNumeric(val) ? String(Number(val)) : quote(val);
}

function resolveColumn(name, config) {
  const row = config.startRow || 2;
  if (config.columnMode === 'letter') {
    return name.toUpperCase() + row;
  }
  const letter = config.headers?.[name];
  if (letter) return letter.toUpperCase() + row;
  // Fallback: treat as column letter if single char A-Z
  if (/^[A-Za-z]{1,3}$/.test(name)) return name.toUpperCase() + row;
  return name + row;
}

function resolveColumnLetter(name, config) {
  if (config.columnMode === 'letter') return name.toUpperCase();
  const letter = config.headers?.[name];
  if (letter) return letter.toUpperCase();
  if (/^[A-Za-z]{1,3}$/.test(name)) return name.toUpperCase();
  return name;
}

// --- Condition builders ---

const CONDITION_BUILDERS = {
  exact(cell, val, cs) {
    return cs ? `EXACT(${cell},${quote(val)})` : `${cell}=${quote(val)}`;
  },
  contains(cell, val) {
    return `ISNUMBER(SEARCH(${quote(val)},${cell}))`;
  },
  not_contains(cell, val) {
    return `ISERROR(SEARCH(${quote(val)},${cell}))`;
  },
  starts_with(cell, val) {
    return `LEFT(${cell},LEN(${quote(val)}))=${quote(val)}`;
  },
  ends_with(cell, val) {
    return `RIGHT(${cell},LEN(${quote(val)}))=${quote(val)}`;
  },
  gt(cell, val) {
    return `${cell}>${numOrQuote(val)}`;
  },
  lt(cell, val) {
    return `${cell}<${numOrQuote(val)}`;
  },
  gte(cell, val) {
    return `${cell}>=${numOrQuote(val)}`;
  },
  lte(cell, val) {
    return `${cell}<=${numOrQuote(val)}`;
  },
  empty(cell) {
    return `${cell}=""`;
  },
  not_empty(cell) {
    return `${cell}<>""`;
  },
  one_of(cell, val) {
    const values = val.split(',').map(v => v.trim()).filter(Boolean);
    if (values.length === 0) return 'FALSE';
    if (values.length === 1) return `${cell}=${numOrQuote(values[0])}`;
    return `OR(${values.map(v => `${cell}=${numOrQuote(v)}`).join(',')})`;
  },
};

function conditionToExcel(condition, config) {
  if (!condition.column) return 'FALSE';
  const cell = resolveColumn(condition.column, config);
  const builder = CONDITION_BUILDERS[condition.type];
  if (!builder) return `${cell}=${quote(condition.value || '')}`;
  // Cross-column comparison: resolve value as cell ref instead of literal
  if (condition.compareColumn && condition.value) {
    const otherCell = resolveColumn(condition.value, config);
    const COMPARE_MAP = { exact: '=', gt: '>', lt: '<', gte: '>=', lte: '<=' };
    const op = COMPARE_MAP[condition.type];
    if (op) return `${cell}${op}${otherCell}`;
  }
  return builder(cell, condition.value || '', condition.caseSensitive);
}

// --- Output template parsing ---

function parseTemplate(template) {
  const segments = [];
  const regex = /\{([^}]+)\}/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'literal', value: template.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'expr', value: match[1] });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < template.length) {
    segments.push({ type: 'literal', value: template.slice(lastIndex) });
  }

  return segments;
}

// Expression resolvers (ordered, first match wins)
const EXPR_RESOLVERS = [
  {
    pattern: /^period\((.+)\)$/,
    resolve: (m, config) => {
      const cell = resolveColumn(m[1].trim(), config);
      return `TEXT(DATE(YEAR(${cell}),MONTH(${cell}),1),"MM/DD/YYYY")`;
    }
  },
  {
    pattern: /^period_plus\((.+),\s*(\d+)\)$/,
    resolve: (m, config) => {
      const cell = resolveColumn(m[1].trim(), config);
      return `TEXT(EDATE(DATE(YEAR(${cell}),MONTH(${cell}),1),${m[2]}),"MM/DD/YYYY")`;
    }
  },
  {
    pattern: /^period_minus\((.+),\s*(\d+)\)$/,
    resolve: (m, config) => {
      const cell = resolveColumn(m[1].trim(), config);
      return `TEXT(EDATE(DATE(YEAR(${cell}),MONTH(${cell}),1),-${m[2]}),"MM/DD/YYYY")`;
    }
  },
  {
    pattern: /^(upper|lower|trim)\((.+)\)$/,
    resolve: (m, config) => {
      const fn = m[1].toUpperCase();
      const cell = resolveColumn(m[2].trim(), config);
      return `${fn}(${cell})`;
    }
  },
  {
    pattern: /^(left|right)\((.+),\s*(\d+)\)$/,
    resolve: (m, config) => {
      const fn = m[1].toUpperCase();
      const cell = resolveColumn(m[2].trim(), config);
      return `${fn}(${cell},${m[3]})`;
    }
  },
  {
    pattern: /^mid\((.+),\s*(\d+),\s*(\d+)\)$/,
    resolve: (m, config) => {
      const cell = resolveColumn(m[1].trim(), config);
      return `MID(${cell},${m[2]},${m[3]})`;
    }
  },
  {
    pattern: /^text\((.+),\s*"([^"]+)"\)$/,
    resolve: (m, config) => {
      const cell = resolveColumn(m[1].trim(), config);
      return `TEXT(${cell},"${m[2]}")`;
    }
  },
  {
    pattern: /^(year|month|day)\((.+)\)$/,
    resolve: (m, config) => {
      const fn = m[1].toUpperCase();
      const cell = resolveColumn(m[2].trim(), config);
      return `${fn}(${cell})`;
    }
  }
];

function resolveExpression(expr, config) {
  expr = expr.trim();
  for (const { pattern, resolve } of EXPR_RESOLVERS) {
    const m = expr.match(pattern);
    if (m) return resolve(m, config);
  }
  // Bare column reference
  return resolveColumn(expr.trim(), config);
}

function buildOutputExpr(template, config) {
  if (!template) return '""';

  const segments = parseTemplate(template);
  if (segments.length === 0) return '""';

  const parts = segments.map(s => {
    if (s.type === 'literal') {
      return quote(s.value);
    }
    return resolveExpression(s.value, config);
  });

  // If single part and it's already a cell ref / function, don't wrap in quotes
  if (parts.length === 1) return parts[0];
  return parts.join('&');
}

// --- Rule chain compilation ---

function buildConditionExpr(rule, config) {
  if (!rule.conditions || rule.conditions.length === 0) return 'TRUE';

  const exprs = rule.conditions.map(c => conditionToExcel(c, config));
  if (exprs.length === 1) return exprs[0];

  const joiner = rule.conditionLogic || 'AND';
  return `${joiner}(${exprs.join(',')})`;
}

function buildRuleChain(rules, index, config) {
  if (index >= rules.length) {
    const def = config.defaultOutput || '';
    if (!def) return '""';
    return buildOutputExpr(def, config);
  }

  const rule = rules[index];
  const cond = buildConditionExpr(rule, config);
  const out = buildOutputExpr(rule.output, config);
  const rest = buildRuleChain(rules, index + 1, config);

  return `IF(${cond},${out},${rest})`;
}

function buildPreFilterExpr(preFilter, config) {
  if (!preFilter || !preFilter.enabled || !preFilter.conditions || preFilter.conditions.length === 0) {
    return null;
  }
  const exprs = preFilter.conditions
    .filter(c => c.column)
    .map(c => conditionToExcel(c, config));
  if (exprs.length === 0) return null;
  if (exprs.length === 1) return exprs[0];
  const joiner = preFilter.conditionLogic || 'AND';
  return `${joiner}(${exprs.join(',')})`;
}

export function compile(config) {
  if (!config.rules || config.rules.length === 0) {
    const def = config.defaultOutput || '';
    const inner = def ? buildOutputExpr(def, config) : '""';
    const pf = buildPreFilterExpr(config.preFilter, config);
    if (pf) return `=IF(${pf},${inner},"")`;
    return '=' + inner;
  }

  const ruleChain = buildRuleChain(config.rules, 0, config);
  const pf = buildPreFilterExpr(config.preFilter, config);
  if (pf) return `=IF(${pf},${ruleChain},"")`;
  return '=' + ruleChain;
}

// Returns an array of { ruleIndex, text } segments for colorized rendering.
// ruleIndex is -1 for structural/prefilter/default parts, 0..N for rules.
export function compileSegmented(config) {
  const segments = [];
  const rules = config.rules || [];

  if (rules.length === 0) {
    const def = config.defaultOutput || '';
    const inner = def ? buildOutputExpr(def, config) : '""';
    const pf = buildPreFilterExpr(config.preFilter, config);
    if (pf) {
      segments.push({ ruleIndex: -1, text: `=IF(${pf},${inner},"")` });
    } else {
      segments.push({ ruleIndex: -1, text: '=' + inner });
    }
    return segments;
  }

  const pf = buildPreFilterExpr(config.preFilter, config);
  if (pf) {
    segments.push({ ruleIndex: -1, text: `=IF(${pf},` });
  } else {
    segments.push({ ruleIndex: -1, text: '=' });
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const cond = buildConditionExpr(rule, config);
    const out = buildOutputExpr(rule.output, config);
    segments.push({ ruleIndex: i, text: `IF(${cond},${out},` });
  }

  // Default output
  const def = config.defaultOutput || '';
  const defExpr = (!def) ? '""' : buildOutputExpr(def, config);
  segments.push({ ruleIndex: -1, text: defExpr + ')'.repeat(rules.length) });

  if (pf) {
    segments.push({ ruleIndex: -1, text: ',"")' });
  }

  return segments;
}

// Expose for testing
export { parseTemplate, buildOutputExpr, buildConditionExpr, resolveColumn };
