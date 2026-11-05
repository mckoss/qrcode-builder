// Local persistence: the in-progress draft and the history of generated codes.
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
  /** The encoded payload, kept for search and de-duplication. */
  payload: string;
  pinned?: boolean;
  /** How the code entered the library. */
  source?: 'scan';
}

/** The editable content of an entry (everything except identity and bookkeeping). */
export type EntryContent = Omit<HistoryEntry, 'id' | 'created' | 'updated' | 'pinned' | 'source'>;

const DRAFT_KEY = 'qrb.draft.v1';
const HISTORY_KEY = 'qrb.history.v1';
export const HISTORY_LIMIT = 200;

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

// ---------- history ----------

function sanitizeEntry(e: unknown): HistoryEntry | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (!isQrTypeId(o.type) || typeof o.payload !== 'string') return null;
  const now = Date.now();
  return {
    id: typeof o.id === 'string' && o.id ? o.id : newId(),
    created: typeof o.created === 'number' ? o.created : now,
    updated: typeof o.updated === 'number' ? o.updated : now,
    type: o.type,
    fields: sanitizeFields(o.type, o.fields),
    style: sanitizeStyle(o.style),
    description: typeof o.description === 'string' ? o.description : '',
    showDescription: o.showDescription !== false,
    showDecoded: o.showDecoded === true,
    payload: o.payload,
    pinned: o.pinned === true,
    source: o.source === 'scan' ? 'scan' : undefined,
  };
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function loadHistory(): HistoryEntry[] {
  const raw = safeGet(HISTORY_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(sanitizeEntry).filter((e): e is HistoryEntry => !!e);
  } catch {
    return [];
  }
}

/** Saves, pruning the oldest unpinned entries if over the limit or out of quota. */
function saveHistory(list: HistoryEntry[]): boolean {
  list.sort((a, b) => b.updated - a.updated);
  const prune = () => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].pinned) {
        list.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  while (list.length > HISTORY_LIMIT && prune()) {
    /* keep pruning */
  }
  while (!safeSet(HISTORY_KEY, JSON.stringify(list))) {
    if (!prune()) return false;
  }
  return true;
}

/** Content identity used to avoid duplicate history entries. */
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
  // Strictly increasing timestamps keep ordering (and pruning) well-defined for rapid saves.
  return Math.max(Date.now(), ...list.map((e) => e.updated + 1));
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
  if (e) Object.assign(e, patch);
  // Preserve ordering by `updated`: pinning is not a "use".
  safeSet(HISTORY_KEY, JSON.stringify(list));
  return list;
}

export function removeEntry(id: string): HistoryEntry[] {
  const list = loadHistory().filter((e) => e.id !== id);
  safeSet(HISTORY_KEY, JSON.stringify(list));
  return list;
}

/** Put back a previously removed entry (undo). */
export function restoreEntry(e: HistoryEntry): HistoryEntry[] {
  const list = loadHistory().filter((x) => x.id !== e.id);
  list.push(e);
  saveHistory(list);
  return loadHistory();
}

export function clearHistory(keepPinned: boolean): HistoryEntry[] {
  const list = keepPinned ? loadHistory().filter((e) => e.pinned) : [];
  safeSet(HISTORY_KEY, JSON.stringify(list));
  return list;
}

export function historyBytes(): number {
  return new Blob([safeGet(HISTORY_KEY) ?? '']).size;
}

export function exportHistory(): string {
  return JSON.stringify({ app: 'qrcode-builder', version: 1, exported: new Date().toISOString(), entries: loadHistory() }, null, 2);
}

/** Merge entries from an exported file. Returns the number of new entries added. */
export function importHistory(json: string): { added: number; list: HistoryEntry[] } {
  const parsed = JSON.parse(json);
  const incoming: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
  const list = loadHistory();
  let added = 0;
  for (const raw of incoming) {
    const e = sanitizeEntry(raw);
    if (!e) continue;
    if (list.some((x) => x.id === e.id || sameContent(x, e))) continue;
    list.push(e);
    added++;
  }
  if (!incoming.length) throw new Error('No QR code entries found in that file.');
  saveHistory(list);
  return { added, list: loadHistory() };
}
