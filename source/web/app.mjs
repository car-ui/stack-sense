import { recommend, invalidResult } from '../engine.mjs';
import { schema } from '../schema.mjs';

const byId = (id) => document.getElementById(id);
const node = (tag, text = '', className = '') => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const human = (value) => value.replaceAll('_', ' ');
const headline = (value) => human(value).replace(/^./, (letter) => letter.toUpperCase());
const has = (obj, key) => obj && Object.hasOwn(obj, key);
const fields = byId('fields');
const raw = byId('raw');
const out = byId('out');
const money = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const cases = ['Portfolio', 'Marketplace', 'Whiteboard', 'Lending', 'Internal HR', 'Offline field'];
let active = null;
let mode = 'fields';
let draft = {};
let result = null;
let loadRequest = 0;
let readers = [];

const groups = {
  project: 'Project and platforms', scale: 'Scale and workload', team: 'Team and languages',
  budget: 'Monthly infrastructure budget', timeline: 'MVP timeline',
  infrastructure: 'Hosting, residency and existing systems', requirements: 'Product capabilities and SLOs',
  compliance: 'Compliance scope', priorities: 'Decision priorities', context: 'Optional sizing refinements',
};
const labels = {
  users_12_months: 'Users at 12 months', data_volume_gb_12_months: 'Data at 12 months (GB)',
  monthly_infra_usd: 'Monthly infrastructure (USD)', mvp_weeks: 'MVP (weeks)', has_devops: 'DevOps owner available',
  p95_latency_ms: 'p95 target (ms)', availability: 'Availability target (%)',
  file_media_storage: 'File and media uploads', languages: 'Languages (comma separated)',
  existing_systems: 'Existing systems (one per line)', residency_region: 'Named local facility for other residency',
  peak_requests_per_second: 'Measured peak requests / second', vendor_lock_in: 'Vendor lock-in tolerance',
  peak_day_requests: 'Forecast requests on busiest day', budget_policy: 'Budget policy',
  data_classification: 'Data classification',
  recovery_point_minutes: 'Maximum data loss (minutes, RPO)',
  recovery_time_minutes: 'Maximum recovery time (minutes, RTO)',
  recovery_scope: 'Failure scope for recovery',
  monthly_egress_gb: 'Internet egress (GB / month)', search_corpus_gb: 'Searchable text (GB)',
};

function makeControl(path, key, def, obj) {
  const original = has(obj, key);
  const value = original ? obj[key] : def.fallback;
  const label = (labels[key] || headline(key)) + (def.fallback === undefined ? ' *' : '');
  const field = node(def.type === 'list' && def.values ? 'fieldset' : 'label', '', 'field');
  field.dataset.path = path;
  let read;
  if (def.type === 'list' && def.values) {
    field.classList.add('wide');
    field.append(node('legend', label));
    const options = node('div', '', 'options');
    const boxes = def.values.map((option) => {
      const box = node('input');
      box.type = 'checkbox';
      box.checked = Array.isArray(value) && value.includes(option);
      const caption = node('label');
      caption.append(box, document.createTextNode(human(option)));
      options.append(caption);
      return [box, option];
    });
    field.append(options);
    read = () => boxes.filter(([box]) => box.checked).map(([, option]) => option);
  } else {
    const input = node(def.type === 'enum' ? 'select' : ['description', 'existing_systems'].includes(key) ? 'textarea' : 'input');
    input.id = 'field-' + path;
    field.htmlFor = input.id;
    if (def.type === 'boolean') {
      field.classList.add('toggle');
      input.type = 'checkbox';
      input.checked = value === true;
      field.append(input, document.createTextNode(label));
      read = () => input.checked;
    } else {
      if (['description', 'existing_systems', 'languages', 'residency_region'].includes(key)) field.classList.add('wide');
      field.append(node('span', label), input);
      if (def.type === 'enum') {
        if (def.fallback === undefined) input.append(new Option('Select…', ''));
        for (const opt of def.values) input.append(new Option(human(opt), opt));
        input.value = typeof value === 'string' ? value : '';
        read = () => input.value || undefined;
      } else if (def.type === 'number' || def.type === 'integer') {
        input.type = 'number';
        input.min = def.min;
        input.step = def.type === 'integer' ? '1' : 'any';
        if (def.max !== undefined) input.max = def.max;
        input.value = value ?? '';
        read = () => input.validity.badInput ? 'invalid number' :
          input.value === '' ? (def.nullable && original && value === null ? null : undefined) : Number(input.value);
      } else if (def.type === 'list') {
        const separator = key === 'languages' ? ',' : '\n';
        input.value = Array.isArray(value) ? value.join(separator === ',' ? ', ' : '\n') : '';
        read = () => input.value.split(separator).map((item) => item.trim()).filter(Boolean);
      } else {
        input.value = typeof value === 'string' ? value : '';
        read = () => input.value;
      }
    }
  }
  let edited = false;
  field.addEventListener('input', () => { edited = true; stale(); });
  readers.push({ path, field, get: () => original || edited || def.fallback === undefined ? read() : undefined });
  return field;
}

function renderForm(data) {
  fields.replaceChildren();
  readers = [];
  for (const [section, rules] of Object.entries(schema)) {
    const group = node('details', '', 'group');
    group.open = section === 'project';
    group.append(node('summary', groups[section]));
    const body = node('div', '', 'group-body');
    if (typeof rules.type === 'string') body.append(makeControl(section, section, rules, data));
    else for (const [key, def] of Object.entries(rules)) body.append(makeControl(section + '.' + key, key, def, data?.[section]));
    group.append(body);
    fields.append(group);
  }
}

function collect() {
  const data = draft && typeof draft === 'object' && !Array.isArray(draft) ? structuredClone(draft) : {};
  for (const { path, get } of readers) {
    const value = get();
    const [section, key] = path.split('.');
    if (key) {
      if (value === undefined) {
        if (data[section] && typeof data[section] === 'object') delete data[section][key];
      } else {
        if (!data[section] || typeof data[section] !== 'object' || Array.isArray(data[section])) data[section] = {};
        data[section][key] = value;
      }
    } else if (value !== undefined) data[section] = value;
    else delete data[section];
  }
  return data;
}

function setMode(next) {
  mode = next;
  fields.hidden = next !== 'fields';
  byId('editor').hidden = next !== 'json';
  byId('fields-mode').setAttribute('aria-pressed', String(next === 'fields'));
  byId('json-mode').setAttribute('aria-pressed', String(next === 'json'));
}

function stale() {
  if (result) {
    byId('notice').textContent = 'Scenario changed. Run again to refresh the decision.';
    byId('export').disabled = true;
  }
}

function select(data, preset) {
  active = preset;
  draft = data;
  renderForm(draft);
  raw.value = JSON.stringify(draft, null, 2);
  for (const button of byId('presets').children) button.setAttribute('aria-pressed', String(button.dataset.preset === active));
}

function disclosure(title, lines) {
  const details = node('details', '', 'disclosure');
  const list = node('ul');
  for (const line of lines) list.append(node('li', line));
  details.append(node('summary', title), list);
  return details;
}

function card(layer, part) {
  const box = node('article', '', 'component');
  box.append(node('div', layer, 'label'), node('h4', part.choice), node('p', part.justification));
  const more = node('details');
  more.append(node('summary', 'Drivers, alternatives and trade-offs'),
    node('p', 'Drivers: ' + part.driven_by.join(', ')));
  for (const alt of part.alternatives) {
    more.append(node('p', alt.choice + ' — ' + alt.why_not));
    if (alt.factors?.length) {
      const changes = node('ul', '', 'fit-factors');
      for (const { field, points } of alt.factors) {
        changes.append(node('li', field + ' · ' + (points > 0 ? '+' : '') + points));
      }
      more.append(changes);
    }
  }
  for (const item of part.tradeoffs) more.append(node('p', item));
  for (const source of part.sources || (part.source ? [part.source] : [])) {
    const link = node('a', 'Technical reference ↗');
    link.href = source;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    more.append(link);
  }
  box.append(more);
  return box;
}

function render(output, data) {
  result = output;
  out.replaceChildren();
  out.dataset.status = output.status;
  byId('export').disabled = false;
  byId('notice').textContent = '';
  for (const { path, field } of readers) {
    const invalid = output.validation_errors.some((error) => error.field === path || error.field.startsWith(path + '['));
    for (const control of field.querySelectorAll('input, select, textarea')) control.setAttribute('aria-invalid', String(invalid));
  }
  const overview = node('div', '', 'overview');
  const copy = node('div');
  const valid = output.status.startsWith('ok');
  const title = [output.scenario_id, typeof data?.project?.name === 'string' ? data.project.name : ''].filter(Boolean).join(' / ');
  copy.append(node('span', headline(output.status) + (valid ? ' · ' + human(output.architecture_style) : ''),
    'status ' + (output.status === 'ok' ? '' : valid ? 'warn' : 'fail')),
    node('h3', title || (valid ? 'Custom scenario' : 'Scenario check')), node('p', output.summary, 'summary'));
  overview.append(copy);
  const cost = output.estimated_monthly_cost_usd;
  if (cost.min !== null) {
    const box = node('div', '', 'estimate');
    box.append(node('strong', '$' + money.format(cost.min) + (cost.min === cost.max ? '' : '–' + money.format(cost.max))),
      node('small', 'Estimated USD / month'));
    if (cost.budget_fit) {
      const budgetState = { within_budget: 'Within budget', overlaps_budget: 'Upper estimate exceeds budget', above_budget: 'Floor exceeds budget' }[cost.budget_fit];
      box.append(node('small', budgetState, 'budget-state ' + cost.budget_fit));
    }
    overview.append(box);
  }
  out.append(overview);
  if (output.stack) {
    const core = node('div', '', 'core');
    for (const key of ['frontend', 'backend', 'database', 'hosting']) core.append(card(key, output.stack[key]));
    out.append(core);
    const architecture = output.architecture_decision;
    if (architecture) {
      const explanation = disclosure('Why this architecture', [
        architecture.justification,
        'Input drivers · ' + architecture.driven_by.join(', '),
        ...architecture.data_flow.map((step, index) => (index + 1) + '. ' + step),
        ...architecture.alternatives.map((alternative) => alternative.choice + ' · ' + alternative.why_not),
        ...architecture.tradeoffs,
      ]);
      const reference = node('a', 'Architecture reference ↗');
      reference.href = architecture.source;
      reference.target = '_blank';
      reference.rel = 'noopener noreferrer';
      explanation.append(reference);
      out.append(explanation);
    }
    if (output.stack.supporting.length) {
      const support = node('div', '', 'support');
      for (const part of output.stack.supporting) {
        const item = node('details');
        item.append(node('summary', headline(part.layer) + ' · ' + part.choice), card(part.layer, part));
        support.append(item);
      }
      out.append(node('h3', 'Supporting services', 'subhead'), support);
    }
  }
  if (output.budget_alternative) {
    const alternative = output.budget_alternative;
    const lines = alternative.status === 'available' ? [
      'The same requirements and policies with a hard cap of $' + money.format(alternative.budget_usd) + ' per month.',
      'Alternative · ' + alternative.stack.frontend + ' / ' + alternative.stack.backend + ' / ' +
        alternative.stack.database + ' / ' + alternative.stack.hosting + ' in ' + alternative.region + '.',
      'Modeled cost · $' + money.format(alternative.estimated_monthly_cost_usd.min) + '–$' +
        money.format(alternative.estimated_monthly_cost_usd.max) + ' per month.',
      ...alternative.new_tradeoffs.map(({ message }) => 'Additional tradeoff · ' + message),
    ] : [
      'No compatible profile fits a hard cap of $' + money.format(alternative.budget_usd) + ' per month.',
      alternative.reason,
    ];
    const comparison = disclosure('Budget-constrained comparison · ' +
      (alternative.status === 'available' ? 'feasible alternative' : 'no feasible alternative'), lines);
    comparison.classList.add('budget-alternative');
    comparison.open = true;
    out.append(comparison);
  }
  const alerts = [...output.validation_errors.map(({field, message}) => ({code: field, message, severity: 'critical'})), ...output.warnings];
  if (alerts.length) {
    const list = node('ul', '', 'alerts');
    for (const {code, message, severity} of alerts) {
      const item = node('li', '', 'alert ' + severity);
      item.append(node('strong', severity.toUpperCase() + ' · ' + code), document.createTextNode(message));
      list.append(item);
    }
    out.append(node('h3', output.validation_errors.length ? 'Validation issues' : 'Constraint and delivery checks', 'subhead'), list);
  }
  if (cost.min !== null) out.append(disclosure('Cost model and assumptions', [
    cost.budget_policy === 'hard_cap' ? 'Budget mode · Hard cap on the modeled upper estimate' : 'Budget mode · Soft planning target',
    ...cost.assumptions,
    ...cost.breakdown.map((item) => item.driver + ' · $' + item.min + '–' + item.max),
  ]));
  if (output.decision_trace) {
    const { eligible_hosting, excluded_hosting } = output.decision_trace;
    out.append(disclosure('Hosting shortlist and policy exclusions', [
      ...eligible_hosting.map((option) => (option.selected ? 'Selected · ' : 'Eligible · ') +
        option.choice + ' / ' + option.database + ' · $' + money.format(option.min_usd) + '–' +
        money.format(option.max_usd) + ' per month · fit ' + option.fit_score),
      ...excluded_hosting.map((option) => 'Excluded · ' + option.choice + ' · ' + option.reason),
    ]));
  }
  const boundary = output.deployment?.boundary;
  if (boundary?.launch_gates.length) {
    const gates = disclosure('Data boundary and launch checks', [
      'Planned placement · ' + boundary.region,
      ...(boundary.data_classification ? ['Data classification · ' + boundary.data_classification] : []),
      'Core data services · ' + boundary.core_data_services.join(', '),
    ]);
    const list = gates.querySelector('ul');
    for (const gate of boundary.launch_gates) {
      const item = node('li', headline(gate.gate) + ' · ' + gate.check);
      if (gate.evidence) {
        const link = node('a', ' Provider scope ↗');
        link.href = gate.evidence;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.append(link);
      }
      list.append(item);
    }
    out.append(gates);
  }
  if (output.recovery_plan) {
    const plan = output.recovery_plan;
    const targets = plan.targets_minutes;
    const recovery = disclosure('Recovery plan and drill', [
      'Strategy · ' + headline(plan.strategy) + ' for ' + human(plan.scope),
      'Data loss target · ' + (targets.max_data_loss === null ? 'Unspecified' : targets.max_data_loss + ' minutes'),
      'Downtime target · ' + (targets.max_service_downtime === null ? 'Unspecified' : targets.max_service_downtime + ' minutes'),
      ...(plan.secondary_region ? ['Recovery region · ' + plan.secondary_region] : []),
      ...plan.runbook,
    ]);
    const list = recovery.querySelector('ul');
    for (const source of plan.references) {
      const item = node('li');
      const link = node('a', 'Recovery documentation ↗');
      link.href = source;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.append(link);
      list.append(item);
    }
    out.append(recovery);
  }
  if (output.assumptions.length) out.append(disclosure('Input defaults and interpretations', output.assumptions));
}

function parse(text) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
function failParse(error) {
  render(invalidResult([{ field: '$', message: 'Invalid JSON: ' + error.message }]), null);
}
function run() {
  try {
    const data = mode === 'json' ? parse(raw.value) : collect();
    render(recommend(data), data);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    failParse(error);
  }
}

for (const [index, title] of cases.entries()) {
  const id = 'P' + (index + 1);
  const button = node('button', id + ' ' + title);
  button.type = 'button';
  button.dataset.preset = id;
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', async () => {
    const request = ++loadRequest;
    try {
      const response = await fetch('/scenarios/' + id + '.json');
      if (!response.ok) throw new Error('Fixture could not be loaded.');
      const data = await response.json();
      if (request !== loadRequest) return;
      select(data, id);
      render(recommend(data), data);
    } catch (error) {
      if (request === loadRequest) byId('notice').textContent = error.message;
    }
  });
  byId('presets').append(button);
}

byId('import').addEventListener('click', () => byId('file').click());
byId('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const request = ++loadRequest;
  event.target.value = '';
  if (file.size > 2_000_000) {
    byId('notice').textContent = 'Choose a JSON scenario under 2 MB.';
    return;
  }
  const contents = await file.text();
  if (request !== loadRequest) return;
  try {
    const data = parse(contents);
    const output = recommend(data);
    select(data, null);
    setMode(output.status === 'invalid_input' ? 'json' : 'fields');
    render(output, data);
  } catch (error) {
    setMode('json');
    raw.value = contents;
    failParse(error);
  }
});
byId('new').addEventListener('click', () => {
  loadRequest++;
  select({}, null);
  setMode('fields');
  result = null;
  delete out.dataset.status;
  out.replaceChildren(node('div', 'Fill the required fields, then choose Recommend stack.', 'empty'));
  byId('export').disabled = true;
  byId('notice').textContent = '';
});
byId('fields-mode').addEventListener('click', () => {
  if (mode === 'fields') return;
  try {
    const data = parse(raw.value);
    if (recommend(data).validation_errors.length) {
      byId('notice').textContent = 'Fix invalid JSON fields before switching to the guided form.';
      return;
    }
    select(data, active);
    setMode('fields');
  } catch (error) {
    failParse(error);
  }
});
byId('json-mode').addEventListener('click', () => {
  if (mode === 'json') return;
  raw.value = JSON.stringify(collect(), null, 2);
  setMode('json');
});
raw.addEventListener('input', stale);
fields.addEventListener('submit', (event) => { event.preventDefault(); run(); });
byId('run').addEventListener('click', run);
byId('export').addEventListener('click', () => {
  if (!result) return;
  const blob = new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' });
  const link = node('a');
  link.href = URL.createObjectURL(blob);
  link.download = (result.scenario_id || 'stacksense').replace(/[^a-zA-Z0-9_-]/g, '_') + '_output.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
renderForm({});
