export class AxiError extends Error {
  constructor(message, code, suggestions = []) {
    super(message);
    this.name = 'AxiError';
    this.code = code;
    this.suggestions = suggestions;
  }
}

const primitive = value => value === null || typeof value !== 'object';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function quote(value) {
  if (!value.isWellFormed()) throw new Error('Output contains an unpaired Unicode surrogate.');
  const escapes = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  return `"${value.replace(/["\\\x00-\x1f]/g, char => escapes[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

const keyText = key => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(key) ? key : quote(key);

function scalar(value) {
  if (typeof value !== 'string') {
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
    return 'null';
  }
  if (!value.isWellFormed()) throw new Error('Output contains an unpaired Unicode surrogate.');
  const needsQuotes = !value || value.trim() !== value || /^[#-]/.test(value)
    || /^(?:true|false|null|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(value)
    || /[:,"\\\[\]{}\x00-\x1f]/.test(value);
  return needsQuotes ? quote(value) : value;
}

function columns(rows) {
  if (!rows.length || !rows.every(object)) return null;
  const keys = Object.keys(rows[0]);
  if (!keys.length || !rows.every(row => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)))) return null;
  const result = [];
  for (const key of keys) {
    const values = rows.map(row => row[key]);
    const nested = values.every(primitive) ? null : columns(values);
    if (!values.every(primitive) && !nested) return null;
    result.push({ key, nested });
  }
  return result;
}

const header = fields => fields.map(({ key, nested }) => `${keyText(key)}${nested ? `{${header(nested)}}` : ''}`).join(',');
const cells = (row, fields) => fields.flatMap(({ key, nested }) => nested ? cells(row[key], nested) : [scalar(row[key])]).join(',');

// ponytail: fixed comma-delimited TOON 4.1 for JSON-shaped CLI output; no decoder or formatting options.
function lines(value, key = '', item = false) {
  const prefix = key ? `${key}:` : '';
  if (primitive(value)) return [`${prefix}${key ? ' ' : ''}${scalar(value)}`];
  const array = Array.isArray(value);
  const entries = array ? [] : Object.entries(value);
  const rows = array ? value : entries.map(([, row]) => row);
  const fields = !item && (array || rows.length >= 2) ? columns(rows) : null;
  if (fields) return [
    `${key}[${rows.length}${array ? '' : ':'}]{${header(fields)}}:`,
    ...rows.map((row, i) => `  ${array ? '' : `${keyText(entries[i][0])}: `}${cells(row, fields)}`),
  ];
  if (!array) {
    const body = entries.flatMap(([name, child]) => lines(child, keyText(name)));
    return key ? [prefix, ...body.map(line => `  ${line}`)] : body;
  }
  if (!value.length) return [item ? '[0]:' : `${prefix}${key ? ' ' : ''}[]`];
  const start = `${key}[${value.length}]:`;
  if (value.every(primitive)) return [`${start} ${value.map(scalar).join(',')}`];
  return [start, ...value.flatMap(child => {
    const [first, ...rest] = lines(child, '', true);
    return [`  -${first === undefined ? '' : ` ${first}`}`, ...rest.map(line => `${Array.isArray(child) ? '  ' : '    '}${line}`)];
  })];
}

export const renderOutput = value => lines(value).join('\n');
