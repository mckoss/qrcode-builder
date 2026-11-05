// Turn a scanned QR payload back into an editable type + fields (the inverse of qrtypes encoders).
import { TYPE_BY_ID, type Fields, type QrTypeId } from './qrtypes';

export interface Parsed {
  type: QrTypeId;
  fields: Fields;
  /** Things in the original that the editable form can't represent (shown to the user). */
  dropped: string[];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function withDefaults(type: QrTypeId, f: Fields): Fields {
  return { ...TYPE_BY_ID[type].defaults, ...f };
}

/** Split on separators not preceded by a backslash escape. */
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const unescapeBackslash = (s: string) => s.replace(/\\(.)/g, '$1');

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse "a=1&b=2" without treating "+" as space (RFC 6068 / RFC 5724). */
function parseQuery(q: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = safeDecode(i < 0 ? part : part.slice(0, i)).toLowerCase();
    if (!m.has(k)) m.set(k, safeDecode(i < 0 ? '' : part.slice(i + 1)));
  }
  return m;
}

// ---------- Wi-Fi ----------

function parseWifi(payload: string): Parsed {
  const props = new Map<string, string>();
  const dropped: string[] = [];
  for (const seg of splitUnescaped(payload.slice(5), ';')) {
    if (!seg) continue;
    const parts = splitUnescaped(seg, ':');
    const key = parts[0].toUpperCase();
    const value = unescapeBackslash(parts.slice(1).join(':'));
    if (!props.has(key)) props.set(key, value);
  }
  let ssid = props.get('S') ?? '';
  // Android quotes SSIDs that could be mistaken for hex.
  if (ssid.length >= 2 && ssid.startsWith('"') && ssid.endsWith('"')) ssid = ssid.slice(1, -1);
  const password = props.get('P') ?? '';
  const t = (props.get('T') ?? '').toUpperCase();
  let security = 'WPA';
  if (t === 'WEP') security = 'WEP';
  else if (t === 'NOPASS' || (!t && !password)) security = 'nopass';
  else if (t && !['WPA', 'WPA2', 'WPA3', 'SAE'].includes(t)) dropped.push(`security type “${props.get('T')}”`);
  const enterprise = [...props.keys()].filter((k) => !['S', 'P', 'T', 'H', 'R'].includes(k));
  if (enterprise.length) dropped.push(`enterprise settings (${enterprise.join(', ')})`);
  return {
    type: 'wifi',
    fields: withDefaults('wifi', {
      ssid,
      security,
      password: security === 'nopass' ? '' : password,
      hidden: /^true$/i.test(props.get('H') ?? ''),
    }),
    dropped,
  };
}

// ---------- email / phone / SMS / geo ----------

function parseMailto(payload: string): Parsed {
  const rest = payload.slice(7);
  const q = rest.indexOf('?');
  const to = safeDecode(q < 0 ? rest : rest.slice(0, q));
  const query = parseQuery(q < 0 ? '' : rest.slice(q + 1));
  const dropped = [...query.keys()].filter((k) => k !== 'subject' && k !== 'body');
  return {
    type: 'email',
    fields: withDefaults('email', { to, subject: query.get('subject') ?? '', body: query.get('body') ?? '' }),
    dropped,
  };
}

function parseMatmsg(payload: string): Parsed {
  const props = new Map<string, string>();
  for (const seg of splitUnescaped(payload.slice(7), ';')) {
    const i = seg.indexOf(':');
    if (i > 0) props.set(seg.slice(0, i).toUpperCase(), unescapeBackslash(seg.slice(i + 1)));
  }
  return {
    type: 'email',
    fields: withDefaults('email', { to: props.get('TO') ?? '', subject: props.get('SUB') ?? '', body: props.get('BODY') ?? '' }),
    dropped: [],
  };
}

function parseSms(payload: string): Parsed {
  const lower = payload.toLowerCase();
  const rest = payload.slice(lower.startsWith('smsto:') ? 6 : 4);
  let number = rest;
  let message = '';
  const q = rest.indexOf('?');
  if (!lower.startsWith('smsto:') && q >= 0) {
    number = rest.slice(0, q).replace(/;$/, '');
    message = parseQuery(rest.slice(q + 1)).get('body') ?? '';
  } else {
    const c = rest.indexOf(':');
    if (c >= 0) {
      number = rest.slice(0, c);
      message = rest.slice(c + 1);
    }
  }
  return { type: 'sms', fields: withDefaults('sms', { number: safeDecode(number), message }), dropped: [] };
}

const GEO = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(,-?\d+(?:\.\d+)?)?([;?].*)?$/i;

function parseGeo(payload: string): Parsed | null {
  const m = GEO.exec(payload.trim());
  if (!m) return null;
  const dropped: string[] = [];
  if (m[3]) dropped.push('altitude');
  if (m[4]) dropped.push('label / extra parameters');
  return { type: 'geo', fields: withDefaults('geo', { lat: m[1], lng: m[2] }), dropped };
}

// ---------- vCard / MECARD ----------

interface ContentLine {
  name: string;
  params: string[];
  value: string;
}

/** Unfold and split RFC 2425-style content lines (vCard, iCalendar). */
function contentLines(text: string): ContentLine[] {
  const unfolded = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '');
  const out: ContentLine[] = [];
  for (const line of unfolded.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const [rawName, ...params] = line.slice(0, i).split(';');
    const name = rawName.replace(/^[^.]*\./, '').toUpperCase();
    let value = line.slice(i + 1);
    if (params.some((p) => /^ENCODING=QUOTED-PRINTABLE$/i.test(p))) value = decodeQuotedPrintable(value);
    out.push({ name, params, value });
  }
  return out;
}

function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  const src = s.replace(/=\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(src[i]));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Unescape an iCalendar / vCard text value. */
export function unescapeVText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

const vparts = (v: string) => splitUnescaped(v, ';').map(unescapeVText);

const VCARD_SILENT = new Set(['BEGIN', 'END', 'VERSION', 'PRODID', 'REV', 'UID', 'KIND', 'SOURCE', 'CLASS']);

function parseVcard(payload: string): Parsed {
  const f: Fields = {};
  const dropped: string[] = [];
  const seen = new Set<string>();
  let fn = '';
  const once = (name: string, apply: () => void) => {
    if (seen.has(name)) dropped.push(`additional ${name.toLowerCase()}`);
    else {
      seen.add(name);
      apply();
    }
  };
  for (const { name, value } of contentLines(payload)) {
    switch (name) {
      case 'N':
        once(name, () => {
          const [last = '', first = '', middle = '', prefix = '', suffix = ''] = vparts(value);
          f.last = last;
          f.first = first;
          if (middle || prefix || suffix) dropped.push('middle name / prefix / suffix');
        });
        break;
      case 'FN':
        fn = unescapeVText(value);
        break;
      case 'ORG':
        once(name, () => {
          const [org = '', ...units] = vparts(value);
          f.org = org;
          if (units.some(Boolean)) dropped.push('department');
        });
        break;
      case 'TITLE':
        once(name, () => (f.title = unescapeVText(value)));
        break;
      case 'TEL':
        once('phone', () => (f.phone = value.replace(/^tel:/i, '')));
        break;
      case 'EMAIL':
        once('email', () => (f.email = unescapeVText(value)));
        break;
      case 'URL':
        once('website', () => (f.url = value));
        break;
      case 'ADR':
        once('address', () => {
          const [pobox = '', ext = '', street = '', city = '', region = '', postcode = '', country = ''] = vparts(value);
          Object.assign(f, { street, city, region, postcode, country });
          if (pobox || ext) dropped.push('PO box / extended address');
        });
        break;
      case 'NOTE':
        once(name, () => (f.note = unescapeVText(value)));
        break;
      default:
        if (!VCARD_SILENT.has(name) && !name.startsWith('X-')) dropped.push(name.toLowerCase());
        else if (name.startsWith('X-')) dropped.push(name);
    }
  }
  if (!f.first && !f.last && fn) f.first = fn;
  return { type: 'vcard', fields: withDefaults('vcard', f), dropped };
}

function parseMecard(payload: string): Parsed {
  const f: Fields = {};
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const seg of splitUnescaped(payload.slice(7), ';')) {
    const i = seg.indexOf(':');
    if (i <= 0) continue;
    const key = seg.slice(0, i).toUpperCase();
    const value = unescapeBackslash(seg.slice(i + 1));
    if (seen.has(key)) {
      dropped.push(`additional ${key.toLowerCase()}`);
      continue;
    }
    seen.add(key);
    switch (key) {
      case 'N': {
        const [last, first] = splitUnescaped(seg.slice(i + 1), ',').map(unescapeBackslash);
        if (first === undefined) f.first = last;
        else Object.assign(f, { last, first });
        break;
      }
      case 'ORG':
        f.org = value;
        break;
      case 'TEL':
        f.phone = value;
        break;
      case 'EMAIL':
        f.email = value;
        break;
      case 'URL':
        f.url = value;
        break;
      case 'ADR':
        f.street = value;
        break;
      case 'NOTE':
        f.note = value;
        break;
      case 'SOUND':
        break;
      default:
        dropped.push(key.toLowerCase());
    }
  }
  return { type: 'vcard', fields: withDefaults('vcard', f), dropped };
}

// ---------- calendar event ----------

const ICS_SILENT = new Set(['BEGIN', 'END', 'UID', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'STATUS', 'TRANSP']);

function isoDateFromIcs(v: string, addDays = 0): string {
  const d = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8) + addDays));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function localInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** iCalendar date-time to a datetime-local value. UTC ("Z") is converted to local time; others are floating. */
function icsDateTime(v: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  if (m[7]) return localInputValue(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))));
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

function parseEvent(payload: string): Parsed {
  const all = contentLines(payload);
  const start = all.findIndex((l) => l.name === 'BEGIN' && /^VEVENT$/i.test(l.value));
  const endIdx = all.findIndex((l, i) => i > start && l.name === 'END' && /^VEVENT$/i.test(l.value));
  const lines = all.slice(start + 1, endIdx < 0 ? undefined : endIdx);
  const f: Fields = {};
  const dropped: string[] = [];
  let dtstart: ContentLine | undefined;
  let dtend: ContentLine | undefined;
  for (const l of lines) {
    switch (l.name) {
      case 'SUMMARY':
        f.title = unescapeVText(l.value);
        break;
      case 'LOCATION':
        f.location = unescapeVText(l.value);
        break;
      case 'DESCRIPTION':
        f.description = unescapeVText(l.value);
        break;
      case 'DTSTART':
        dtstart = l;
        break;
      case 'DTEND':
        dtend = l;
        break;
      default:
        if (!ICS_SILENT.has(l.name)) dropped.push(l.name.toLowerCase());
    }
  }
  const isDate = (l?: ContentLine) =>
    !!l && (l.params.some((p) => /^VALUE=DATE$/i.test(p)) || /^\d{8}$/.test(l.value.trim()));
  if (dtstart?.params.some((p) => /^TZID=/i.test(p))) dropped.push('time zone (times kept as shown)');
  if (dtstart && isDate(dtstart)) {
    f.allDay = true;
    f.startDate = isoDateFromIcs(dtstart.value.trim());
    if (dtend && isDate(dtend)) {
      const last = isoDateFromIcs(dtend.value.trim(), -1);
      f.endDate = last > f.startDate ? last : '';
    }
  } else if (dtstart) {
    f.start = icsDateTime(dtstart.value.trim()) ?? '';
    if (dtend) f.end = icsDateTime(dtend.value.trim()) ?? '';
  }
  return { type: 'event', fields: withDefaults('event', f), dropped };
}

// ---------- entry point ----------

function detect(payload: string): Parsed | null {
  const p = payload;
  const lower = p.toLowerCase();
  if (lower.startsWith('wifi:')) return parseWifi(p);
  if (lower.startsWith('mailto:')) return parseMailto(p);
  if (lower.startsWith('matmsg:')) return parseMatmsg(p);
  if (lower.startsWith('tel:'))
    return { type: 'phone', fields: withDefaults('phone', { number: safeDecode(p.slice(4)) }), dropped: [] };
  if (lower.startsWith('smsto:') || lower.startsWith('sms:')) return parseSms(p);
  if (lower.startsWith('geo:')) return parseGeo(p);
  if (/^begin:vcard/i.test(p.trim())) return parseVcard(p);
  if (lower.startsWith('mecard:')) return parseMecard(p);
  if (/^(begin:vcalendar|begin:vevent)/i.test(p.trim())) return parseEvent(p);
  if (/^https?:\/\/\S+$/i.test(p)) return { type: 'url', fields: withDefaults('url', { url: p }), dropped: [] };
  return null;
}

/** Best structured interpretation of a payload, falling back to plain text. */
export function parsePayload(payload: string): Parsed {
  const text: Parsed = { type: 'text', fields: withDefaults('text', { text: payload }), dropped: [] };
  let parsed: Parsed | null = null;
  try {
    parsed = detect(payload);
  } catch {
    parsed = null;
  }
  if (!parsed) return text;
  try {
    TYPE_BY_ID[parsed.type].encode(parsed.fields);
  } catch {
    return text; // e.g. a Wi-Fi code without an SSID: keep it as text rather than lose it.
  }
  parsed.dropped = [...new Set(parsed.dropped)];
  return parsed;
}
