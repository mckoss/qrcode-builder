// QR content types: form definitions, payload encoders, and human-readable "decoded" text.
// Pure functions only (no DOM) so they can be unit tested.

export type FieldValue = string | boolean;
export type Fields = Record<string, FieldValue>;

export type QrTypeId =
  | 'wifi'
  | 'text'
  | 'url'
  | 'email'
  | 'phone'
  | 'sms'
  | 'vcard'
  | 'geo'
  | 'event';

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'password'
  | 'select'
  | 'checkbox'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'datetime-local'
  | 'date';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  /** Span the full width of the form grid. */
  wide?: boolean;
  hint?: string;
  autocomplete?: string;
  inputmode?: string;
  step?: string;
  showIf?: (f: Fields) => boolean;
}

export interface QrTypeDef {
  id: QrTypeId;
  label: string;
  fields: FieldDef[];
  defaults: Fields;
  /** Build the string encoded in the QR code. Throws ValidationError for unusable input. */
  encode(f: Fields): string;
  /** Plain-text rendition shown under the code (e.g. SSID and password). */
  decoded(f: Fields): string;
  /** Short label used for history entries and file names. */
  summary(f: Fields): string;
}

export class ValidationError extends Error {}

// ---------- helpers ----------

const raw = (f: Fields, k: string): string => {
  const v = f[k];
  return typeof v === 'string' ? v : '';
};
const str = (f: Fields, k: string): string => raw(f, k).trim();
const bool = (f: Fields, k: string): boolean => f[k] === true;

function need(value: string, what: string): string {
  if (!value) throw new ValidationError(`Enter ${what}.`);
  return value;
}

/** Escape for the MECARD-style WIFI: format. */
export function escapeWifi(s: string): string {
  return s.replace(/([\\;,":])/g, '\\$1');
}

/** Escape a vCard / iCalendar text value. */
export function escapeVText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function lines(...parts: (string | false | undefined | null)[]): string {
  return parts.filter((p): p is string => !!p).join('\n');
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Format a Date as an iCalendar UTC date-time: 20261105T143000Z */
export function icsUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** "2026-11-05" -> "20261105", optionally offset by days. */
export function icsDate(isoDate: string, addDays = 0): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new ValidationError('Enter a valid date.');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + addDays));
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function parseLocalDateTime(v: string, what: string): Date {
  // datetime-local yields "YYYY-MM-DDTHH:MM" (optionally :SS), which Date parses as local time.
  const d = new Date(v);
  if (!v || isNaN(d.getTime())) throw new ValidationError(`Enter ${what}.`);
  return d;
}

export function normalizeUrl(u: string): string {
  if (!u) return u;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
}

function cleanPhone(p: string): string {
  return p.replace(/[^\d+*#,;]/g, '');
}

function phoneOrThrow(p: string): string {
  const c = cleanPhone(p);
  if (!/\d/.test(c)) throw new ValidationError('Enter a phone number.');
  return c;
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ---------- type definitions ----------

const wifi: QrTypeDef = {
  id: 'wifi',
  label: 'Wi-Fi',
  fields: [
    { key: 'ssid', label: 'Network name (SSID)', kind: 'text', required: true, autocomplete: 'off', wide: true },
    {
      key: 'security',
      label: 'Security',
      kind: 'select',
      options: [
        { value: 'WPA', label: 'WPA / WPA2 / WPA3' },
        { value: 'WEP', label: 'WEP (legacy)' },
        { value: 'nopass', label: 'None (open network)' },
      ],
    },
    {
      key: 'password',
      label: 'Password',
      kind: 'password',
      autocomplete: 'off',
      showIf: (f) => f.security !== 'nopass',
    },
    { key: 'hidden', label: 'Hidden network', kind: 'checkbox' },
  ],
  defaults: { ssid: '', security: 'WPA', password: '', hidden: false },
  encode(f) {
    const ssid = raw(f, 'ssid');
    if (!ssid.trim()) throw new ValidationError('Enter the network name (SSID).');
    const sec = str(f, 'security') || 'WPA';
    const pw = raw(f, 'password');
    let out = `WIFI:T:${sec};S:${escapeWifi(ssid)};`;
    if (sec !== 'nopass') {
      if (!pw) throw new ValidationError('Enter the Wi-Fi password, or choose “None”.');
      out += `P:${escapeWifi(pw)};`;
    }
    if (bool(f, 'hidden')) out += 'H:true;';
    return out + ';';
  },
  decoded(f) {
    const sec = str(f, 'security') || 'WPA';
    return lines(
      `Network: ${raw(f, 'ssid')}`,
      sec === 'nopass' ? 'Open network (no password)' : `Password: ${raw(f, 'password')}`,
    );
  },
  summary: (f) => raw(f, 'ssid').trim() || 'Wi-Fi',
};

const text: QrTypeDef = {
  id: 'text',
  label: 'Text',
  fields: [
    {
      key: 'text',
      label: 'Text',
      kind: 'textarea',
      required: true,
      wide: true,
      placeholder: 'Any text — encoded exactly as typed.',
    },
  ],
  defaults: { text: '' },
  encode(f) {
    const t = raw(f, 'text');
    if (!t) throw new ValidationError('Enter some text.');
    return t;
  },
  decoded: (f) => raw(f, 'text'),
  summary: (f) => raw(f, 'text').trim().split('\n')[0] || 'Text',
};

const url: QrTypeDef = {
  id: 'url',
  label: 'URL',
  fields: [
    {
      key: 'url',
      label: 'Web address',
      kind: 'url',
      required: true,
      wide: true,
      placeholder: 'https://example.com',
      inputmode: 'url',
      hint: 'https:// is added if you leave the scheme off.',
    },
  ],
  defaults: { url: '' },
  encode(f) {
    return normalizeUrl(need(str(f, 'url'), 'a web address'));
  },
  decoded: (f) => normalizeUrl(str(f, 'url')),
  summary: (f) => str(f, 'url').replace(/^https?:\/\//i, '') || 'URL',
};

const email: QrTypeDef = {
  id: 'email',
  label: 'Email',
  fields: [
    { key: 'to', label: 'To', kind: 'email', required: true, wide: true, placeholder: 'name@example.com' },
    { key: 'subject', label: 'Subject', kind: 'text', wide: true },
    { key: 'body', label: 'Message', kind: 'textarea', wide: true },
  ],
  defaults: { to: '', subject: '', body: '' },
  encode(f) {
    const to = need(str(f, 'to').replace(/\s+/g, ''), 'an email address');
    const q: string[] = [];
    if (str(f, 'subject')) q.push(`subject=${encodeURIComponent(str(f, 'subject'))}`);
    if (raw(f, 'body').trim()) q.push(`body=${encodeURIComponent(raw(f, 'body'))}`);
    return `mailto:${to}${q.length ? '?' + q.join('&') : ''}`;
  },
  decoded: (f) =>
    lines(`Email: ${str(f, 'to')}`, str(f, 'subject') && `Subject: ${str(f, 'subject')}`, raw(f, 'body').trim()),
  summary: (f) => str(f, 'to') || 'Email',
};

const phone: QrTypeDef = {
  id: 'phone',
  label: 'Phone',
  fields: [
    { key: 'number', label: 'Phone number', kind: 'tel', required: true, wide: true, placeholder: '+1 555 123 4567' },
  ],
  defaults: { number: '' },
  encode: (f) => `tel:${phoneOrThrow(str(f, 'number'))}`,
  decoded: (f) => str(f, 'number'),
  summary: (f) => str(f, 'number') || 'Phone',
};

const sms: QrTypeDef = {
  id: 'sms',
  label: 'SMS',
  fields: [
    { key: 'number', label: 'Phone number', kind: 'tel', required: true, wide: true, placeholder: '+1 555 123 4567' },
    { key: 'message', label: 'Message', kind: 'textarea', wide: true },
  ],
  defaults: { number: '', message: '' },
  encode(f) {
    const n = phoneOrThrow(str(f, 'number'));
    const m = raw(f, 'message');
    return m ? `SMSTO:${n}:${m}` : `SMSTO:${n}`;
  },
  decoded: (f) => lines(`SMS: ${str(f, 'number')}`, raw(f, 'message').trim()),
  summary: (f) => str(f, 'number') || 'SMS',
};

const vcard: QrTypeDef = {
  id: 'vcard',
  label: 'Contact',
  fields: [
    { key: 'first', label: 'First name', kind: 'text', autocomplete: 'off' },
    { key: 'last', label: 'Last name', kind: 'text', autocomplete: 'off' },
    { key: 'org', label: 'Organization', kind: 'text' },
    { key: 'title', label: 'Job title', kind: 'text' },
    { key: 'phone', label: 'Phone', kind: 'tel' },
    { key: 'email', label: 'Email', kind: 'email' },
    { key: 'url', label: 'Website', kind: 'url', wide: true, inputmode: 'url' },
    { key: 'street', label: 'Street', kind: 'text', wide: true },
    { key: 'city', label: 'City', kind: 'text' },
    { key: 'region', label: 'State / region', kind: 'text' },
    { key: 'postcode', label: 'Postal code', kind: 'text' },
    { key: 'country', label: 'Country', kind: 'text' },
    { key: 'note', label: 'Note', kind: 'textarea', wide: true },
  ],
  defaults: {
    first: '',
    last: '',
    org: '',
    title: '',
    phone: '',
    email: '',
    url: '',
    street: '',
    city: '',
    region: '',
    postcode: '',
    country: '',
    note: '',
  },
  encode(f) {
    const first = str(f, 'first');
    const last = str(f, 'last');
    const org = str(f, 'org');
    if (!first && !last && !org) throw new ValidationError('Enter a name or organization.');
    const fn = [first, last].filter(Boolean).join(' ') || org;
    const e = escapeVText;
    const out = ['BEGIN:VCARD', 'VERSION:3.0', `N:${e(last)};${e(first)};;;`, `FN:${e(fn)}`];
    if (org) out.push(`ORG:${e(org)}`);
    if (str(f, 'title')) out.push(`TITLE:${e(str(f, 'title'))}`);
    if (str(f, 'phone')) out.push(`TEL;TYPE=CELL:${cleanPhone(str(f, 'phone'))}`);
    if (str(f, 'email')) out.push(`EMAIL:${str(f, 'email')}`);
    if (str(f, 'url')) out.push(`URL:${normalizeUrl(str(f, 'url'))}`);
    const adr = ['street', 'city', 'region', 'postcode', 'country'].map((k) => str(f, k));
    if (adr.some(Boolean)) out.push(`ADR;TYPE=WORK:;;${adr.map(e).join(';')}`);
    if (raw(f, 'note').trim()) out.push(`NOTE:${e(raw(f, 'note').trim())}`);
    out.push('END:VCARD');
    return out.join('\r\n');
  },
  decoded(f) {
    const name = [str(f, 'first'), str(f, 'last')].filter(Boolean).join(' ');
    const role = [str(f, 'title'), str(f, 'org')].filter(Boolean).join(', ');
    const place = [str(f, 'city'), str(f, 'region')].filter(Boolean).join(', ');
    return lines(
      name,
      role,
      str(f, 'phone'),
      str(f, 'email'),
      str(f, 'url') && normalizeUrl(str(f, 'url')).replace(/^https?:\/\//i, ''),
      str(f, 'street'),
      [place, str(f, 'postcode')].filter(Boolean).join(' '),
      str(f, 'country'),
    );
  },
  summary: (f) => [str(f, 'first'), str(f, 'last')].filter(Boolean).join(' ') || str(f, 'org') || 'Contact',
};

function coord(v: string, max: number, what: string): string {
  const n = Number(v);
  if (v === '' || !isFinite(n) || Math.abs(n) > max) throw new ValidationError(`Enter a valid ${what}.`);
  // Trim needless precision (6 decimals ≈ 0.1 m) without changing the user's digits otherwise.
  return String(Math.round(n * 1e6) / 1e6);
}

const geo: QrTypeDef = {
  id: 'geo',
  label: 'Location',
  fields: [
    { key: 'lat', label: 'Latitude', kind: 'number', required: true, step: 'any', placeholder: '47.6205', inputmode: 'decimal' },
    { key: 'lng', label: 'Longitude', kind: 'number', required: true, step: 'any', placeholder: '-122.3493', inputmode: 'decimal' },
  ],
  defaults: { lat: '', lng: '' },
  encode(f) {
    return `geo:${coord(str(f, 'lat'), 90, 'latitude')},${coord(str(f, 'lng'), 180, 'longitude')}`;
  },
  decoded: (f) => `${str(f, 'lat')}, ${str(f, 'lng')}`,
  summary: (f) => (str(f, 'lat') ? `${str(f, 'lat')}, ${str(f, 'lng')}` : 'Location'),
};

const event: QrTypeDef = {
  id: 'event',
  label: 'Event',
  fields: [
    { key: 'title', label: 'Title', kind: 'text', required: true, wide: true },
    { key: 'allDay', label: 'All-day event', kind: 'checkbox', wide: true },
    { key: 'start', label: 'Starts', kind: 'datetime-local', required: true, showIf: (f) => !f.allDay },
    { key: 'end', label: 'Ends', kind: 'datetime-local', showIf: (f) => !f.allDay },
    { key: 'startDate', label: 'Start date', kind: 'date', required: true, showIf: (f) => !!f.allDay },
    { key: 'endDate', label: 'End date', kind: 'date', showIf: (f) => !!f.allDay },
    { key: 'location', label: 'Location', kind: 'text', wide: true },
    { key: 'description', label: 'Details', kind: 'textarea', wide: true },
  ],
  defaults: { title: '', allDay: false, start: '', end: '', startDate: '', endDate: '', location: '', description: '' },
  encode(f) {
    const e = escapeVText;
    const out = ['BEGIN:VEVENT', `SUMMARY:${e(need(str(f, 'title'), 'an event title'))}`];
    if (bool(f, 'allDay')) {
      const s = need(str(f, 'startDate'), 'a start date');
      const endIso = str(f, 'endDate') || s;
      if (endIso < s) throw new ValidationError('The end date is before the start date.');
      out.push(`DTSTART;VALUE=DATE:${icsDate(s)}`, `DTEND;VALUE=DATE:${icsDate(endIso, 1)}`);
    } else {
      const s = parseLocalDateTime(str(f, 'start'), 'a start time');
      out.push(`DTSTART:${icsUtc(s)}`);
      if (str(f, 'end')) {
        const en = parseLocalDateTime(str(f, 'end'), 'an end time');
        if (en < s) throw new ValidationError('The end time is before the start time.');
        out.push(`DTEND:${icsUtc(en)}`);
      }
    }
    if (str(f, 'location')) out.push(`LOCATION:${e(str(f, 'location'))}`);
    if (raw(f, 'description').trim()) out.push(`DESCRIPTION:${e(raw(f, 'description').trim())}`);
    out.push('END:VEVENT');
    return out.join('\r\n');
  },
  decoded(f) {
    let when = '';
    if (bool(f, 'allDay')) {
      const s = str(f, 'startDate');
      const en = str(f, 'endDate');
      when = s ? fmtDate(s) + (en && en !== s ? ` – ${fmtDate(en)}` : '') : '';
    } else {
      const s = str(f, 'start');
      const en = str(f, 'end');
      when = s ? fmtDateTime(new Date(s)) + (en ? ` – ${fmtDateTime(new Date(en))}` : '') : '';
    }
    return lines(str(f, 'title'), when, str(f, 'location'));
  },
  summary: (f) => str(f, 'title') || 'Event',
};

export const QR_TYPES: QrTypeDef[] = [wifi, text, url, email, phone, sms, vcard, geo, event];

export const TYPE_BY_ID = Object.fromEntries(QR_TYPES.map((t) => [t.id, t])) as Record<QrTypeId, QrTypeDef>;

export function isQrTypeId(v: unknown): v is QrTypeId {
  return typeof v === 'string' && v in TYPE_BY_ID;
}
