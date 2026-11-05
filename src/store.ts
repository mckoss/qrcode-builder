// Local persistence: the in-progress draft and the library of saved codes.
import { QR_TYPES, TYPE_BY_ID, isQrTypeId, type Fields, type QrTypeId } from './qrtypes';
import type { Style } from './render';

export interface Draft {
  type: QrTypeId;
  data: Record<QrTypeId, Fields>;
  style: Style;
  description: string;
  showDescription: boolean;
  showDecoded: boolean;
  pngWidth: number;
  pdfWidth: number;
  pdfUnit: 'in' | 'cm';
  /** Library entry being revised in the editor, if any. */
  editingId: string | null;
}

export interface HistoryEntry {
  id: string;
  created: number;
  updated: number;
  type: QrTypeId;
  fields: Fields;
  style: Style;
  description: string;
  showDescription: boolean;
  showDecoded: boolean;
  /**
   * The encoded payload. Derived from `type` + `fields` when the library is loaded and never
   * persisted: only source data is stored, and codes are redrawn on demand.
   */
  payload: string;
  pinned?: boolean;
  /** How the code entered the library. */
  source?: 'scan';
}

/** The editable content of an entry (everything except identity and bookkeeping). */
export type EntryContent = Omit<HistoryEntry, 'id' | 'created' | 'updated' | 'pinned' | 'source'>;

const DRAFT_KEY = 'qrb.draft.v1';
/** Library, stored compactly (source data only). */
const LIBRARY_KEY = 'qrb.library.v2';
/** Pre-1.2 format (full entries plus payload); migrated into LIBRARY_KEY on load. */
const LEGACY_KEY = 'qrb.history.v1';

export const DEFAULT_STYLE: Style = { fg: '#000000', bg: '#ffffff', transparent: true, ec: 'M', margin: 4 };

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function defaultDraft(): Draft {
  return {
    type: 'wifi',
    data: Object.fromEntries(QR_TYPES.map((t) => [t.id, { ...t.defaults }])) as Record<QrTypeId, Fields>,
    style: { ...DEFAULT_STYLE },
    description: '',
    showDescription: true,
    showDecoded: false,
    pngWidth: 1024,
    pdfWidth: 3,
    pdfUnit: 'in',
    editingId: null,
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

export function sanitizeStyle(s: unknown): Style {
  const d = { ...DEFAULT_STYLE };
  if (!s || typeof s !== 'object') return d;
  const o = s as Record<string, unknown>;
  return {
    fg: typeof o.fg === 'string' && HEX.test(o.fg) ? o.fg : d.fg,
    bg: typeof o.bg === 'string' && HEX.test(o.bg) ? o.bg : d.bg,
    transparent: typeof o.transparent === 'boolean' ? o.transparent : d.transparent,
    ec: o.ec === 'L' || o.ec === 'M' || o.ec === 'Q' || o.ec === 'H' ? o.ec : d.ec,
    margin: typeof o.margin === 'number' && o.margin >= 0 && o.margin <= 10 ? Math.round(o.margin) : d.margin,
  };
}

function sanitizeFields(type: QrTypeId, f: unknown): Fields {
  const out: Fields = { ...TYPE_BY_ID[type].defaults };
  if (f && typeof f === 'object') {
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (k in out && (typeof v === 'string' || typeof v === 'boolean')) out[k] = v;
    }
  }
  return out;
}

export function loadDraft(): Draft {
  const d = defaultDraft();
  const raw = safeGet(DRAFT_KEY);
  if (!raw) return d;
  try {
    const o = JSON.parse(raw) as Partial<Draft>;
    if (isQrTypeId(o.type)) d.type = o.type;
    for (const t of QR_TYPES) d.data[t.id] = sanitizeFields(t.id, o.data?.[t.id]);
    d.style = sanitizeStyle(o.style);
    if (typeof o.description === 'string') d.description = o.description;
    if (typeof o.showDescription === 'boolean') d.showDescription = o.showDescription;
    if (typeof o.showDecoded === 'boolean') d.showDecoded = o.showDecoded;
    if (typeof o.pngWidth === 'number' && o.pngWidth >= 64 && o.pngWidth <= 8192) d.pngWidth = o.pngWidth;
    if (typeof o.pdfWidth === 'number' && o.pdfWidth > 0 && o.pdfWidth <= 100) d.pdfWidth = o.pdfWidth;
    if (o.pdfUnit === 'in' || o.pdfUnit === 'cm') d.pdfUnit = o.pdfUnit;
    if (typeof o.editingId === 'string') d.editingId = o.editingId;
  } catch {
    /* corrupted draft: start fresh */
  }
  return d;
}

export function saveDraft(d: Draft): void {
  safeSet(DRAFT_KEY, JSON.stringify(d));
}

// ---------- library ----------
//
// Storage format (v2): an array of compact records holding only what is needed to regenerate a
// code. Nothing derived is stored: no images, and no encoded payload (re-encoded from the fields).
// Empty strings and false booleans are omitted from `fields` (they are every type's "empty"
// value), as are the optional flags below when they have their usual value. This keeps a typical
// code to roughly 100-250 bytes, so localStorage (about 5 MB per site) holds tens of thousands.

/**
 * Baseline for stored styles: only properties that differ from it are written. This is part of the
 * storage format and must never change (unlike DEFAULT_STYLE, which is just the editor's default).
 */
const STORED_STYLE_BASE: Readonly<Style> = Object.freeze({
  fg: '#000000',
  bg: '#ffffff',
  transparent: true,
  ec: 'M',
  margin: 4,
});

interface StoredEntry {
  id: string;
  created: number;
  updated: number;
  type: QrTypeId;
  /** Non-empty fields only. */
  fields?: Fields;
  /** Only properties that differ from STORED_STYLE_BASE. */
  style?: Partial<Style>;
  description?: string;
  /** Present only when false. */
  showDescription?: false;
  /** Present only when true. */
  showDecoded?: true;
  pinned?: true;
  source?: 'scan';
}

function toStored(e: HistoryEntry): StoredEntry {
  const fields: Fields = {};
  for (const [k, v] of Object.entries(e.fields)) if (v !== '' && v !== false) fields[k] = v;
  const style: Partial<Style> = {};
  for (const k of Object.keys(STORED_STYLE_BASE) as (keyof Style)[]) {
    if (e.style[k] !== STORED_STYLE_BASE[k]) (style as Record<string, unknown>)[k] = e.style[k];
  }
  const out: StoredEntry = { id: e.id, created: e.created, updated: e.updated, type: e.type };
  if (Object.keys(fields).length) out.fields = fields;
  if (Object.keys(style).length) out.style = style;
  if (e.description) out.description = e.description;
  if (!e.showDescription) out.showDescription = false;
  if (e.showDecoded) out.showDecoded = true;
  if (e.pinned) out.pinned = true;
  if (e.source) out.source = e.source;
  return out;
}

/** Validate a stored (v2) or legacy (v1) record and regenerate its payload. */
function sanitizeEntry(e: unknown): HistoryEntry | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (!isQrTypeId(o.type)) return null;
  const fields = sanitizeFields(o.type, o.fields);
  let payload: string;
  try {
    payload = TYPE_BY_ID[o.type].encode(fields);
  } catch {
    return null; // not a usable code
  }
  const now = Date.now();
  return {
    id: typeof o.id === 'string' && o.id ? o.id : newId(),
    created: typeof o.created === 'number' ? o.created : now,
    updated: typeof o.updated === 'number' ? o.updated : now,
    type: o.type,
    fields,
    style: sanitizeStyle({ ...STORED_STYLE_BASE, ...(o.style && typeof o.style === 'object' ? o.style : {}) }),
    description: typeof o.description === 'string' ? o.description : '',
    showDescription: o.showDescription !== false,
    showDecoded: o.showDecoded === true,
    payload,
    pinned: o.pinned === true,
    source: o.source === 'scan' ? 'scan' : undefined,
  };
}

/** Short, unique-enough ids (time + randomness) to keep records small. */
function newId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'getRandomValues' in crypto
      ? Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('')
      : Math.random().toString(36).slice(2);
  return Date.now().toString(36) + rand.slice(0, 8);
}

function parseList(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(sanitizeEntry).filter((e): e is HistoryEntry => !!e) : [];
  } catch {
    return [];
  }
}

const copy = (e: HistoryEntry): HistoryEntry => ({ ...e, fields: { ...e.fields }, style: { ...e.style } });

// Parsing (and re-encoding) thousands of codes is cached until the stored string changes.
let cache: { raw: string; list: HistoryEntry[] } | null = null;

/** Move entries saved by earlier versions into the compact format, then drop the old copy. */
function migrateLegacy(): void {
  const legacy = safeGet(LEGACY_KEY);
  if (legacy === null) return;
  const current = parseList(safeGet(LIBRARY_KEY));
  const byId = new Map(current.map((e) => [e.id, e]));
  for (const e of parseList(legacy)) {
    const have = byId.get(e.id);
    if (!have || have.updated < e.updated) byId.set(e.id, e);
  }
  if (saveHistory([...byId.values()])) {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }
}

export function loadHistory(): HistoryEntry[] {
  migrateLegacy();
  const raw = safeGet(LIBRARY_KEY) ?? '';
  if (cache?.raw !== raw) cache = { raw, list: parseList(raw) };
  return cache.list.map(copy);
}

/** Persist the whole library, newest first. Returns false if storage is full (nothing is pruned). */
function saveHistory(list: HistoryEntry[]): boolean {
  list.sort((a, b) => b.updated - a.updated);
  const raw = JSON.stringify(list.map(toStored));
  if (!safeSet(LIBRARY_KEY, raw)) return false;
  cache = { raw, list: list.map(copy) };
  return true;
}

/** Content identity used to avoid duplicate entries. */
export function sameContent(a: EntryContent, b: EntryContent): boolean {
  return (
    a.type === b.type &&
    a.payload === b.payload &&
    a.description === b.description &&
    a.showDescription === b.showDescription &&
    a.showDecoded === b.showDecoded &&
    JSON.stringify(a.style) === JSON.stringify(b.style)
  );
}

function nextTimestamp(list: HistoryEntry[]): number {
  // Strictly increasing timestamps keep ordering well-defined for rapid saves.
  let max = 0;
  for (const e of list) if (e.updated > max) max = e.updated;
  return Math.max(Date.now(), max + 1);
}

/** Add a code, or bump an identical existing one. Returns the entry's id. */
export function addToHistory(
  item: EntryContent,
  opts: { source?: 'scan'; dedupe?: boolean } = {},
): { list: HistoryEntry[]; ok: boolean; id: string } {
  const list = loadHistory();
  const now = nextTimestamp(list);
  const existing = opts.dedupe === false ? undefined : list.find((e) => sameContent(e, item));
  let id: string;
  if (existing) {
    existing.updated = now;
    existing.fields = { ...item.fields };
    id = existing.id;
  } else {
    id = newId();
    list.push({
      ...item,
      fields: { ...item.fields },
      style: { ...item.style },
      id,
      created: now,
      updated: now,
      ...(opts.source ? { source: opts.source } : {}),
    });
  }
  const ok = saveHistory(list);
  return { list: loadHistory(), ok, id };
}

export function getEntry(id: string): HistoryEntry | undefined {
  return loadHistory().find((e) => e.id === id);
}

/** Revise an entry in place, keeping its id, creation time, pin and source. Null if it no longer exists. */
export function reviseEntry(id: string, item: EntryContent): { list: HistoryEntry[]; ok: boolean } | null {
  const list = loadHistory();
  const e = list.find((x) => x.id === id);
  if (!e) return null;
  Object.assign(e, { ...item, fields: { ...item.fields }, style: { ...item.style }, updated: nextTimestamp(list) });
  const ok = saveHistory(list);
  return { list: loadHistory(), ok };
}

export function updateEntry(id: string, patch: Partial<Pick<HistoryEntry, 'pinned'>>): HistoryEntry[] {
  const list = loadHistory();
  const e = list.find((x) => x.id === id);
  if (e) Object.assign(e, patch); // pinning is not a "use", so `updated` is unchanged
  saveHistory(list);
  return loadHistory();
}

export function removeEntry(id: string): HistoryEntry[] {
  saveHistory(loadHistory().filter((e) => e.id !== id));
  return loadHistory();
}

/** Put back a previously removed entry (undo). */
export function restoreEntry(e: HistoryEntry): HistoryEntry[] {
  const list = loadHistory().filter((x) => x.id !== e.id);
  list.push(copy(e));
  saveHistory(list);
  return loadHistory();
}

export function clearHistory(keepPinned: boolean): HistoryEntry[] {
  saveHistory(keepPinned ? loadHistory().filter((e) => e.pinned) : []);
  return loadHistory();
}

/** Bytes the library occupies in storage. */
export function historyBytes(): number {
  return new Blob([safeGet(LIBRARY_KEY) ?? '']).size;
}

export function exportHistory(): string {
  const entries = loadHistory().map(toStored);
  return JSON.stringify({ app: 'qrcode-builder', version: 2, exported: new Date().toISOString(), entries }, null, 2);
}

/** Merge entries from an exported file (current or pre-1.2 format). Returns the number added. */
export function importHistory(json: string): { added: number; list: HistoryEntry[]; ok: boolean } {
  const parsed = JSON.parse(json);
  const incoming: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
  if (!incoming.length) throw new Error('No QR code entries found in that file.');
  const list = loadHistory();
  let added = 0;
  for (const raw of incoming) {
    const e = sanitizeEntry(raw);
    if (!e) continue;
    if (list.some((x) => x.id === e.id || sameContent(x, e))) continue;
    list.push(e);
    added++;
  }
  const ok = saveHistory(list);
  return { added: ok ? added : 0, list: loadHistory(), ok };
}
