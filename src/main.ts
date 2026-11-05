import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { CapacityError, makeMatrix, type EcLevel, type Matrix } from './qr';
import { parsePayload, type Parsed } from './parse';
import { QR_TYPES, TYPE_BY_ID, ValidationError, type FieldDef, type Fields, type QrTypeDef, type QrTypeId } from './qrtypes';
import {
  canvasMeasure,
  computeLayout,
  contrastRatio,
  luminance,
  renderCanvas,
  renderSvg,
  renderThumb,
  type TextSpec,
} from './render';
import { cameraErrorMessage, CameraScanner, decodeImage, listCameras } from './scan';
import {
  addToHistory,
  clearHistory,
  DEFAULT_STYLE,
  exportHistory,
  historyBytes,
  importHistory,
  loadDraft,
  loadHistory,
  removeEntry,
  restoreEntry,
  reviseEntry,
  sameContent,
  saveDraft,
  updateEntry,
  type EntryContent,
  type HistoryEntry,
} from './store';

// ---------- DOM helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

let toastTimer = 0;
function toast(message: string, opts: { action?: string; onAction?: () => void; duration?: number } = {}): void {
  const el = $('toast');
  el.replaceChildren(h('span', { text: message }));
  if (opts.action && opts.onAction) {
    const act = opts.onAction;
    el.append(
      h('button', {
        type: 'button',
        text: opts.action,
        onclick: () => {
          el.hidden = true;
          act();
        },
      }),
    );
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  if (opts.duration !== Infinity) toastTimer = window.setTimeout(() => (el.hidden = true), opts.duration ?? 3200);
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function slug(s: string): string {
  // ASCII-only: some browsers fall back to a generic "download" name for non-ASCII file names.
  const out = s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return out || 'code';
}

// ---------- state ----------

const draft = loadDraft();
let history = loadHistory();

interface Current {
  def: QrTypeDef;
  payload: string;
  matrix: Matrix;
  text: TextSpec;
  label: string;
}
let current: Current | null = null;

let saveTimer = 0;
function persistDraft(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveDraft(draft), 250);
}

function flushDraft(): void {
  clearTimeout(saveTimer);
  saveDraft(draft);
}

// Don't lose the last keystrokes if the app is closed or backgrounded within the debounce window.
window.addEventListener('pagehide', flushDraft);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushDraft());

// ---------- type picker & fields ----------

const typePicker = $('type-picker');
const fieldsForm = $<HTMLFormElement>('fields');
const fieldActions = $('field-actions');

function buildTypePicker(): void {
  typePicker.replaceChildren(
    ...QR_TYPES.map((t) =>
      h('button', {
        type: 'button',
        role: 'radio',
        'data-type': t.id,
        text: t.label,
        onclick: () => selectType(t.id),
      }),
    ),
  );
  typePicker.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = QR_TYPES.findIndex((t) => t.id === draft.type);
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = QR_TYPES[(i + step + QR_TYPES.length) % QR_TYPES.length];
    selectType(next.id);
    (typePicker.querySelector(`[data-type="${next.id}"]`) as HTMLElement).focus();
  });
}

function syncTypePicker(): void {
  for (const b of typePicker.querySelectorAll<HTMLButtonElement>('button')) {
    const on = b.dataset.type === draft.type;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function selectType(id: QrTypeDef['id']): void {
  if (draft.type === id) return;
  const editing = editingEntry();
  if (editing) {
    // A different type is a different code: never overwrite the library entry being edited.
    if (!confirmDiscard()) {
      syncTypePicker();
      return;
    }
    draft.editingId = null;
    draft.description = '';
    syncControls();
    toast(`Started a new ${TYPE_BY_ID[id].label} code. “${entryLabel(editing)}” is still in your library.`);
  }
  draft.type = id;
  syncTypePicker();
  buildFields();
  update();
}

function buildFields(): void {
  const def = TYPE_BY_ID[draft.type];
  const data = draft.data[def.id];
  fieldsForm.replaceChildren(...def.fields.map((f) => buildField(def, f, data)));
  applyVisibility();

  fieldActions.replaceChildren();
  if (def.id === 'geo' && 'geolocation' in navigator) {
    fieldActions.append(
      h('button', { type: 'button', class: 'btn small', text: 'Use my current location', onclick: useMyLocation }),
    );
  }
}

function buildField(def: QrTypeDef, f: FieldDef, data: Record<string, string | boolean>): HTMLElement {
  const id = `f-${def.id}-${f.key}`;
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement;
    data[f.key] = f.kind === 'checkbox' ? el.checked : el.value;
    if (f.kind === 'checkbox' || f.kind === 'select') applyVisibility();
    update();
  };

  if (f.kind === 'checkbox') {
    return h(
      'label',
      { class: `check${f.wide ? ' wide' : ''}`, 'data-key': f.key },
      h('input', { type: 'checkbox', id, checked: data[f.key] === true, onchange: onInput }),
      h('span', { text: f.label }),
    );
  }

  let control: HTMLElement;
  const value = typeof data[f.key] === 'string' ? (data[f.key] as string) : '';
  if (f.kind === 'select') {
    const sel = h('select', { id, onchange: onInput });
    for (const o of f.options ?? []) sel.append(h('option', { value: o.value, text: o.label }));
    sel.value = value;
    control = sel;
  } else if (f.kind === 'textarea') {
    control = h('textarea', { id, rows: 3, placeholder: f.placeholder, oninput: onInput });
    (control as HTMLTextAreaElement).value = value;
  } else if (f.kind === 'password') {
    const input = h('input', {
      id,
      type: 'password',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      oninput: onInput,
    });
    input.value = value;
    const toggle = h('button', {
      type: 'button',
      class: 'btn small',
      text: 'Show',
      'aria-controls': id,
      onclick: () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.textContent = show ? 'Hide' : 'Show';
      },
    });
    control = h('div', { class: 'password-wrap' }, input, toggle);
  } else {
    const input = h('input', {
      id,
      type: f.kind,
      placeholder: f.placeholder,
      autocomplete: f.autocomplete,
      inputmode: f.inputmode,
      step: f.step,
      spellcheck: f.kind === 'text' ? undefined : 'false',
      autocapitalize: ['email', 'url'].includes(f.kind) ? 'off' : undefined,
      oninput: onInput,
    });
    input.value = value;
    control = input;
  }

  return h(
    'div',
    { class: `field${f.wide ? ' wide' : ''}`, 'data-key': f.key },
    h('label', { class: 'label', for: id, text: f.label + (f.required ? ' *' : '') }),
    control,
    f.hint ? h('span', { class: 'hint', text: f.hint }) : null,
  );
}

function applyVisibility(): void {
  const def = TYPE_BY_ID[draft.type];
  const data = draft.data[def.id];
  for (const f of def.fields) {
    const el = fieldsForm.querySelector<HTMLElement>(`[data-key="${f.key}"]`);
    if (el) el.hidden = f.showIf ? !f.showIf(data) : false;
  }
}

function useMyLocation(): void {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const data = draft.data.geo;
      data.lat = String(Math.round(pos.coords.latitude * 1e6) / 1e6);
      data.lng = String(Math.round(pos.coords.longitude * 1e6) / 1e6);
      buildFields();
      update();
    },
    (err) => toast(`Couldn’t get your location: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

// ---------- text & appearance controls ----------

const descEl = $<HTMLTextAreaElement>('description');
const showDescEl = $<HTMLInputElement>('show-description');
const showDecodedEl = $<HTMLInputElement>('show-decoded');
const fgColor = $<HTMLInputElement>('fg-color');
const fgHex = $<HTMLInputElement>('fg-hex');
const bgColor = $<HTMLInputElement>('bg-color');
const bgHex = $<HTMLInputElement>('bg-hex');
const marginEl = $<HTMLInputElement>('margin');
const pngWidthEl = $<HTMLInputElement>('png-width');
const pdfWidthEl = $<HTMLInputElement>('pdf-width');
const pdfUnitEl = $<HTMLSelectElement>('pdf-unit');

const SWATCHES = ['#000000', '#1f2937', '#1d4ed8', '#047857', '#7c2d12', '#6d28d9', '#be123c', '#ffffff'];

function normalizeHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

function bindColor(picker: HTMLInputElement, hexInput: HTMLInputElement, key: 'fg' | 'bg'): void {
  picker.addEventListener('input', () => {
    draft.style[key] = picker.value.toLowerCase();
    hexInput.value = draft.style[key];
    update();
  });
  hexInput.addEventListener('input', () => {
    const v = normalizeHex(hexInput.value);
    if (!v) return;
    draft.style[key] = v;
    picker.value = v;
    update();
  });
  hexInput.addEventListener('blur', () => (hexInput.value = draft.style[key]));
}

function syncControls(): void {
  descEl.value = draft.description;
  showDescEl.checked = draft.showDescription;
  showDecodedEl.checked = draft.showDecoded;
  fgColor.value = fgHex.value = draft.style.fg;
  bgColor.value = bgHex.value = draft.style.bg;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="bg-mode"]')) {
    r.checked = r.value === (draft.style.transparent ? 'transparent' : 'solid');
  }
  $('bg-row').hidden = draft.style.transparent;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="ec"]')) r.checked = r.value === draft.style.ec;
  marginEl.value = String(draft.style.margin);
  $('margin-value').textContent = `(${draft.style.margin})`;
  pngWidthEl.value = String(draft.pngWidth);
  pdfWidthEl.value = String(draft.pdfWidth);
  pdfUnitEl.value = draft.pdfUnit;
}

function bindControls(): void {
  descEl.addEventListener('input', () => {
    draft.description = descEl.value;
    update();
  });
  showDescEl.addEventListener('change', () => {
    draft.showDescription = showDescEl.checked;
    update();
  });
  showDecodedEl.addEventListener('change', () => {
    draft.showDecoded = showDecodedEl.checked;
    update();
  });
  bindColor(fgColor, fgHex, 'fg');
  bindColor(bgColor, bgHex, 'bg');
  $('fg-swatches').replaceChildren(
    ...SWATCHES.map((c) =>
      h('button', {
        type: 'button',
        title: c,
        'aria-label': `Use color ${c}`,
        style: `background:${c}`,
        onclick: () => {
          draft.style.fg = c;
          syncControls();
          update();
        },
      }),
    ),
  );
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="bg-mode"]')) {
    r.addEventListener('change', () => {
      draft.style.transparent = r.value === 'transparent';
      syncControls();
      update();
    });
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="ec"]')) {
    r.addEventListener('change', () => {
      draft.style.ec = r.value as EcLevel;
      update();
    });
  }
  marginEl.addEventListener('input', () => {
    draft.style.margin = Number(marginEl.value);
    $('margin-value').textContent = `(${draft.style.margin})`;
    update();
  });
  pngWidthEl.addEventListener('change', () => {
    const v = Math.round(Number(pngWidthEl.value));
    draft.pngWidth = isFinite(v) ? Math.min(8192, Math.max(64, v)) : 1024;
    pngWidthEl.value = String(draft.pngWidth);
    update();
  });
  pdfWidthEl.addEventListener('change', () => {
    const v = Number(pdfWidthEl.value);
    draft.pdfWidth = isFinite(v) && v > 0 ? Math.min(40, Math.max(0.25, v)) : 3;
    pdfWidthEl.value = String(draft.pdfWidth);
    persistDraft();
    updateOutputSize();
  });
  pdfUnitEl.addEventListener('change', () => {
    const next = pdfUnitEl.value as 'in' | 'cm';
    if (next !== draft.pdfUnit) {
      // Keep the physical size when switching units.
      draft.pdfWidth = Math.round((next === 'cm' ? draft.pdfWidth * 2.54 : draft.pdfWidth / 2.54) * 100) / 100;
      draft.pdfUnit = next;
      pdfWidthEl.value = String(draft.pdfWidth);
      persistDraft();
      updateOutputSize();
    }
  });
}

// ---------- preview ----------

const previewCanvas = $<HTMLCanvasElement>('preview');
const previewStage = $('preview-stage');
const previewEmpty = $('preview-empty');
const exportButtons = ['dl-png', 'dl-pdf', 'dl-svg', 'copy-png', 'share-png', 'save-history'].map((id) =>
  $<HTMLButtonElement>(id),
);

let updateQueued = false;
function update(): void {
  persistDraft();
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(() => {
    updateQueued = false;
    compute();
    paintPreview();
  });
}

function textSpecFor(def: QrTypeDef, fields: Record<string, string | boolean>, d: {
  description: string;
  showDescription: boolean;
  showDecoded: boolean;
}): TextSpec {
  return {
    description: d.showDescription ? d.description : '',
    decoded: d.showDecoded ? def.decoded(fields) : '',
  };
}

function compute(): void {
  const def = TYPE_BY_ID[draft.type];
  const fields = draft.data[def.id];
  current = null;
  let message = '';
  try {
    const payload = def.encode(fields);
    const matrix = makeMatrix(payload, draft.style.ec);
    current = {
      def,
      payload,
      matrix,
      text: textSpecFor(def, fields, draft),
      label: draft.description.trim().split('\n')[0] || def.summary(fields),
    };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof CapacityError) message = err.message;
    else {
      console.error(err);
      message = 'Couldn’t build this code.';
    }
  }
  previewEmpty.textContent = message;
  for (const b of exportButtons) b.disabled = !current;
  $('payload').textContent = current?.payload ?? '';
  previewStage.classList.toggle('checker', draft.style.transparent);

  const warning = $('warning');
  const warnings: string[] = [];
  const { fg, bg, transparent, margin } = draft.style;
  if (transparent) {
    if (luminance(fg) > 0.35)
      warnings.push('Light codes need a dark backdrop, and some scanners can’t read light-on-dark (inverted) codes.');
  } else if (contrastRatio(fg, bg) < 3) {
    warnings.push('Low contrast between code and background — it may not scan.');
  } else if (luminance(fg) > luminance(bg)) {
    warnings.push('Inverted (light-on-dark) codes don’t scan on some readers.');
  }
  if (margin < 2) warnings.push('A small quiet zone can hurt scanning unless the code sits on a plain area.');
  warning.textContent = warnings.join(' ');
  warning.hidden = !current || !warnings.length;

  if (current) {
    const { matrix, payload } = current;
    const bytes = new TextEncoder().encode(payload).length;
    $('meta').textContent = `Version ${matrix.version} · ${matrix.size}×${matrix.size} modules · EC ${matrix.ec} · ${bytes} bytes`;
    updateOutputSize();
  } else {
    $('meta').textContent = '';
    $('output-size').textContent = '';
  }
  updateEditState();
}

/** Show the exact PNG dimensions and the (approximate, font-dependent) PDF page size. */
function updateOutputSize(): void {
  if (!current) return;
  const { matrix, text } = current;
  const measure = canvasMeasure();
  const png = computeLayout(matrix.size, draft.style.margin, draft.pngWidth, text, measure);
  const pdf = computeLayout(matrix.size, draft.style.margin, draft.pdfWidth, text, measure);
  const unit = draft.pdfUnit;
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
  const approx = text.description || text.decoded ? '≈ ' : '';
  $('output-size').textContent =
    `PNG ${Math.round(png.width)} × ${Math.ceil(png.height)} px · ` +
    `PDF page ${approx}${fmt(pdf.width)} × ${fmt(pdf.height)} ${unit}`;
}

function paintPreview(): void {
  if (!current) {
    previewCanvas.hidden = true;
    return;
  }
  previewCanvas.hidden = false;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cssWidth = Math.max(160, Math.min(previewStage.clientWidth - 34, 520));
  renderCanvas(previewCanvas, current.matrix, draft.style, current.text, Math.round(cssWidth * dpr));
  previewCanvas.style.width = `${previewCanvas.width / dpr}px`;
  previewCanvas.setAttribute('aria-label', `QR code: ${current.label}`);
}

new ResizeObserver(() => current && paintPreview()).observe(previewStage);

// ---------- export ----------

function pngBlob(c: Current): Promise<Blob> {
  const canvas = document.createElement('canvas');
  renderCanvas(canvas, c.matrix, draft.style, c.text, draft.pngWidth);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}

const fileBase = (c: Current) => `qr-${slug(c.label)}`;

// ---------- library: saving and revising ----------

function currentContent(): EntryContent | null {
  if (!current) return null;
  return {
    type: current.def.id,
    fields: { ...draft.data[current.def.id] },
    style: { ...draft.style },
    description: draft.description,
    showDescription: draft.showDescription,
    showDecoded: draft.showDecoded,
    payload: current.payload,
  };
}

/** The library entry the editor is revising, if it still exists. */
function editingEntry(): HistoryEntry | undefined {
  if (!draft.editingId) return undefined;
  const e = history.find((x) => x.id === draft.editingId);
  if (!e) draft.editingId = null; // deleted elsewhere: the editor now holds a new, unsaved code
  return e;
}

function isDirty(): boolean {
  const e = editingEntry();
  const c = currentContent();
  return !e || !c || !sameContent(e, c);
}

/**
 * Save the editor's code to the library. When revising an entry, the entry is updated in place;
 * otherwise a new entry is created (or an identical one reused) and the editor attaches to it.
 */
function saveCurrent(opts: { asCopy?: boolean } = {}): boolean {
  const content = currentContent();
  if (!content) return false;
  let ok = true;
  const revised = draft.editingId && !opts.asCopy ? reviseEntry(draft.editingId, content) : null;
  if (revised) {
    history = revised.list;
    ok = revised.ok;
  } else {
    const added = addToHistory(content, { dedupe: !opts.asCopy });
    history = added.list;
    ok = added.ok;
    draft.editingId = added.id;
  }
  if (!ok) toast('Storage is full — couldn’t save to the library. Delete some codes.');
  flushDraft();
  renderHistoryCount();
  updateEditState();
  // Ask the browser not to evict our storage (best effort, silent).
  navigator.storage?.persist?.().catch(() => {});
  return ok;
}

/** Exports also save: they create the code in the library, or record the revision being exported. */
function recordHistory(): void {
  saveCurrent();
}

function updateEditState(): void {
  const e = editingEntry();
  const dirty = isDirty();
  const banner = $('edit-banner');
  banner.hidden = !e;
  const saveBtn = $<HTMLButtonElement>('save-history');
  if (e) {
    $('edit-kicker').textContent = e.source === 'scan' ? 'Scanned code · in your library' : 'Editing library code';
    $('edit-title').textContent = entryLabel(e);
    const state = $('edit-state');
    state.textContent = !current
      ? 'Incomplete — fix the content to save'
      : dirty
        ? 'Unsaved changes'
        : `Saved ${new Date(e.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    state.classList.toggle('dirty', dirty);
    saveBtn.textContent = dirty ? 'Save changes' : 'Saved';
    saveBtn.disabled = !current || !dirty;
    $<HTMLButtonElement>('edit-copy').disabled = !current;
  } else {
    saveBtn.textContent = 'Save to library';
    saveBtn.disabled = !current;
  }
}

/** Ask before throwing away unsaved revisions of a library code. */
function confirmDiscard(): boolean {
  const e = editingEntry();
  if (!e || !isDirty()) return true;
  return window.confirm(`Discard unsaved changes to “${entryLabel(e)}”?`);
}

function loadIntoEditor(e: HistoryEntry): void {
  draft.editingId = e.id;
  draft.type = e.type;
  draft.data[e.type] = { ...TYPE_BY_ID[e.type].defaults, ...e.fields };
  draft.style = { ...e.style };
  draft.description = e.description;
  draft.showDescription = e.showDescription;
  draft.showDecoded = e.showDecoded;
  syncControls();
  syncTypePicker();
  buildFields();
  showView('create');
  update();
  window.scrollTo({ top: 0 });
}

function startNewCode(): void {
  if (!confirmDiscard()) return;
  draft.editingId = null;
  draft.data[draft.type] = { ...TYPE_BY_ID[draft.type].defaults };
  draft.description = '';
  syncControls();
  buildFields();
  update();
  (fieldsForm.querySelector('input, textarea, select') as HTMLElement | null)?.focus();
}

function bindExports(): void {
  $('dl-png').addEventListener('click', async () => {
    if (!current) return;
    const c = current;
    download(await pngBlob(c), `${fileBase(c)}.png`);
    recordHistory();
  });

  $('dl-pdf').addEventListener('click', async () => {
    if (!current) return;
    const c = current;
    const btn = $<HTMLButtonElement>('dl-pdf');
    btn.disabled = true;
    try {
      const { buildPdf } = await import('./pdf');
      const pt = draft.pdfWidth * (draft.pdfUnit === 'in' ? 72 : 72 / 2.54);
      download(buildPdf(c.matrix, draft.style, c.text, pt, c.label), `${fileBase(c)}.pdf`);
      recordHistory();
    } catch (err) {
      console.error(err);
      toast('Couldn’t create the PDF.');
    } finally {
      btn.disabled = !current;
    }
  });

  $('dl-svg').addEventListener('click', () => {
    if (!current) return;
    const svg = renderSvg(current.matrix, draft.style, current.text, canvasMeasure());
    download(new Blob([svg], { type: 'image/svg+xml' }), `${fileBase(current)}.svg`);
    recordHistory();
  });

  const copyBtn = $<HTMLButtonElement>('copy-png');
  copyBtn.hidden = !(navigator.clipboard && 'write' in navigator.clipboard && 'ClipboardItem' in window);
  copyBtn.addEventListener('click', async () => {
    if (!current) return;
    try {
      // Pass the promise directly: Safari requires ClipboardItem creation within the user gesture.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(current) })]);
      toast('Image copied to clipboard.');
      recordHistory();
    } catch (err) {
      console.error(err);
      toast('Copying images isn’t allowed here — use Download instead.');
    }
  });

  const shareBtn = $<HTMLButtonElement>('share-png');
  shareBtn.hidden = !('share' in navigator && 'canShare' in navigator);
  shareBtn.addEventListener('click', async () => {
    if (!current) return;
    const c = current;
    const file = new File([await pngBlob(c)], `${fileBase(c)}.png`, { type: 'image/png' });
    if (!navigator.canShare({ files: [file] })) {
      toast('Sharing images isn’t supported on this device.');
      return;
    }
    try {
      await navigator.share({ files: [file], title: c.label });
      recordHistory();
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') toast('Sharing failed.');
    }
  });

  $('save-history').addEventListener('click', () => {
    if (!current) return;
    const wasEditing = !!editingEntry();
    if (saveCurrent()) toast(wasEditing ? 'Changes saved.' : 'Saved to your library.');
  });
  $('edit-copy').addEventListener('click', () => {
    if (!current) return;
    if (saveCurrent({ asCopy: true })) toast('Saved as a new code. You’re now editing the copy.');
  });
  $('edit-new').addEventListener('click', startNewCode);
}

// ---------- history view ----------

const historyList = $('history-list');
const historySearch = $<HTMLInputElement>('history-search');

function renderHistoryCount(): void {
  $('history-count').textContent = history.length ? history.length.toLocaleString() : '';
}

function entryLabel(e: HistoryEntry): string {
  return e.description.trim().split('\n')[0] || TYPE_BY_ID[e.type].summary(e.fields);
}

// The library can hold thousands of codes: cards are added a page at a time as you scroll,
// and each thumbnail is drawn from its source data only when it scrolls into view.
const PAGE_SIZE = 60;
let shownCount = PAGE_SIZE;
let filteredItems: HistoryEntry[] = [];

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const canvas = en.target as HTMLCanvasElement & { entry?: HistoryEntry };
      thumbObserver.unobserve(canvas);
      const e = canvas.entry;
      if (!e) continue;
      try {
        renderThumb(canvas, makeMatrix(e.payload, e.style.ec), e.style, Math.round(84 * Math.min(window.devicePixelRatio || 1, 3)));
      } catch {
        /* unrenderable entry: leave blank */
      }
    }
  },
  { rootMargin: '400px 0px' },
);

const moreObserver = new IntersectionObserver((entries) => {
  if (entries.some((en) => en.isIntersecting) && shownCount < filteredItems.length) {
    shownCount += PAGE_SIZE;
    appendHistoryCards();
  }
});

function renderHistory(resetPaging = false): void {
  if (resetPaging) shownCount = PAGE_SIZE;
  renderHistoryCount();
  const q = historySearch.value.trim().toLowerCase();
  const items = history
    .slice()
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updated - a.updated)
    .filter(
      (e) =>
        !q ||
        [entryLabel(e), e.description, e.payload, TYPE_BY_ID[e.type].label].some((s) => s.toLowerCase().includes(q)),
    );

  const kb = historyBytes() / 1024;
  const size = kb < 10 ? `${kb.toFixed(1)} KB` : kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
  $('storage-usage').textContent = `${history.length.toLocaleString()} code${history.length === 1 ? '' : 's'} · ${size}`;
  $('history-empty').hidden = items.length > 0;
  $('history-empty').textContent = history.length
    ? 'No matches.'
    : 'No saved codes yet. Create one, or scan an existing code to clone it.';

  filteredItems = items;
  for (const c of historyList.querySelectorAll('canvas')) thumbObserver.unobserve(c);
  historyList.replaceChildren();
  appendHistoryCards();
}

function appendHistoryCards(): void {
  const from = historyList.querySelectorAll('.history-item').length;
  const to = Math.min(shownCount, filteredItems.length);
  historyList.querySelector('.history-more')?.remove();
  for (const e of filteredItems.slice(from, to)) historyList.append(historyCard(e));
  if (to < filteredItems.length) {
    const more = h('li', { class: 'history-more' }, h('button', {
      type: 'button',
      class: 'btn',
      text: `Show more (${(filteredItems.length - to).toLocaleString()} left)`,
      onclick: () => {
        shownCount += PAGE_SIZE;
        appendHistoryCards();
      },
    }));
    historyList.append(more);
    moreObserver.disconnect();
    moreObserver.observe(more);
  }
}

function historyCard(e: HistoryEntry): HTMLLIElement {
  const canvas = h('canvas', { width: 1, height: 1 }) as HTMLCanvasElement & { entry?: HistoryEntry };
  canvas.entry = e;
  thumbObserver.observe(canvas);
  const date = new Date(e.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const isEditing = e.id === draft.editingId;
  return h(
    'li',
    { class: `history-item${isEditing ? ' editing' : ''}` },
    h(
      'button',
      { type: 'button', class: 'thumb', title: 'Edit', 'aria-label': `Edit ${entryLabel(e)}`, onclick: () => openEntry(e) },
      canvas,
    ),
    h(
      'div',
      { class: 'history-body' },
      h(
        'div',
        { class: 'history-title', title: entryLabel(e) },
        (e.pinned ? '📌 ' : '') + entryLabel(e),
        isEditing ? h('span', { class: 'tag', text: 'Editing' }) : null,
      ),
      h(
        'div',
        { class: 'history-sub' },
        `${TYPE_BY_ID[e.type].label}${e.source === 'scan' ? ' · Scanned' : ''} · ${date}`,
      ),
      h('div', { class: 'history-sub', title: e.payload, text: e.payload.replace(/\s+/g, ' ') }),
      h(
        'div',
        { class: 'history-actions' },
        h('button', { type: 'button', class: 'btn', text: 'Edit', onclick: () => openEntry(e) }),
        h('button', {
          type: 'button',
          class: `btn${e.pinned ? ' pin-on' : ''}`,
          text: e.pinned ? 'Unpin' : 'Pin',
          'aria-pressed': String(!!e.pinned),
          onclick: () => {
            history = updateEntry(e.id, { pinned: !e.pinned });
            renderHistory();
          },
        }),
        h('button', {
          type: 'button',
          class: 'btn danger',
          text: 'Delete',
          onclick: () => {
            const wasEditing = draft.editingId === e.id;
            history = removeEntry(e.id);
            if (wasEditing) draft.editingId = null;
            renderHistory();
            updateEditState();
            toast('Deleted.', {
              action: 'Undo',
              duration: 6000,
              onAction: () => {
                history = restoreEntry(e);
                if (wasEditing && !draft.editingId) draft.editingId = e.id;
                renderHistory();
                updateEditState();
              },
            });
          },
        }),
      ),
    ),
  );
}

function openEntry(e: HistoryEntry): void {
  if (e.id !== draft.editingId && !confirmDiscard()) return;
  loadIntoEditor(e);
}

function bindHistory(): void {
  let searchTimer = 0;
  historySearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => renderHistory(true), 120);
  });

  $('history-export').addEventListener('click', () => {
    const date = new Date().toISOString().slice(0, 10);
    download(new Blob([exportHistory()], { type: 'application/json' }), `qr-library-${date}.json`);
  });

  const fileInput = $<HTMLInputElement>('history-file');
  $('history-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const r = importHistory(await file.text());
      history = r.list;
      renderHistory(true);
      updateEditState();
      const n = (k: number, word: string) => `${k.toLocaleString()} ${word}`;
      const parts = [
        r.added && n(r.added, `new code${r.added === 1 ? '' : 's'} added`),
        r.updated && n(r.updated, `code${r.updated === 1 ? '' : 's'} updated to a newer version`),
        r.duplicates && n(r.duplicates, `duplicate${r.duplicates === 1 ? '' : 's'} skipped`),
        r.invalid && n(r.invalid, `unreadable entr${r.invalid === 1 ? 'y' : 'ies'} ignored`),
      ].filter(Boolean);
      toast(
        !r.ok
          ? 'Not enough storage to import those codes. Nothing was changed.'
          : r.added || r.updated
            ? `Import complete: ${parts.join(', ')}.`
            : `Nothing new to import (${parts.join(', ')}).`,
        { duration: 6000 },
      );
    } catch (err) {
      toast(err instanceof Error && err.message.startsWith('No QR') ? err.message : 'That file isn’t a library export.');
    }
  });

  const dialog = $<HTMLDialogElement>('clear-dialog');
  $('history-clear').addEventListener('click', () => {
    if (!history.length) return;
    dialog.returnValue = '';
    dialog.showModal();
  });
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'all' || dialog.returnValue === 'unpinned') {
      history = clearHistory(dialog.returnValue === 'unpinned');
      renderHistory();
      updateEditState();
      toast('Library cleared.');
    }
  });

  // Keep in sync if another tab changes storage.
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('qrb.history')) {
      history = loadHistory();
      if (!$('view-history').hidden) renderHistory();
      else renderHistoryCount();
      updateEditState();
    }
  });
}

// ---------- scanning (clone an existing code) ----------

const scanDialog = $<HTMLDialogElement>('scan-dialog');
const scanVideo = $<HTMLVideoElement>('scan-video');
const scanStatus = $('scan-status');
let scanner: CameraScanner | null = null;
let scanned: { payload: string; parsed: Parsed } | null = null;

function setScanStatus(msg: string): void {
  scanStatus.textContent = msg;
}

async function startCamera(deviceId?: string): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setScanStatus(
      window.isSecureContext
        ? 'This browser can’t use the camera. You can scan a code from an image instead.'
        : 'The camera needs a secure (https) connection. You can scan a code from an image instead.',
    );
    return;
  }
  setScanStatus('Starting camera…');
  try {
    scanner ??= new CameraScanner(scanVideo, (text) => {
      navigator.vibrate?.(40);
      showScanResult(text);
    });
    await scanner.start(deviceId);
    if (!scanDialog.open) {
      scanner.stop();
      return;
    }
    setScanStatus('Point your camera at a QR code.');
    const cams = await listCameras().catch(() => []);
    $('scan-switch').hidden = cams.length < 2;
  } catch (err) {
    console.warn(err);
    setScanStatus(cameraErrorMessage(err));
  }
}

function openScanner(): void {
  scanned = null;
  $('scan-live').hidden = false;
  $('scan-result').hidden = true;
  setScanStatus('');
  scanDialog.showModal();
  void startCamera();
}

function showScanResult(payload: string): void {
  scanner?.stop();
  const parsed = parsePayload(payload);
  scanned = { payload, parsed };
  const def = TYPE_BY_ID[parsed.type];
  $('scan-type').textContent = def.label;
  $('scan-preview').textContent = parsed.type === 'text' ? payload : def.decoded(parsed.fields) || payload;
  const dropped = $('scan-dropped');
  dropped.hidden = !parsed.dropped.length;
  dropped.textContent = parsed.dropped.length
    ? `These details can’t be edited and will be left out: ${parsed.dropped.join(', ')}. Choose “Keep exact text” to preserve the original exactly.`
    : '';
  $('scan-as-text').hidden = parsed.type === 'text';
  $('scan-accept').textContent = parsed.type === 'text' ? 'Add to library & edit' : `Add as ${def.label} & edit`;
  $('scan-live').hidden = true;
  $('scan-result').hidden = false;
  ($('scan-accept') as HTMLButtonElement).focus();
}

async function scanFile(file: Blob): Promise<void> {
  setScanStatus('Looking for a QR code…');
  try {
    const text = await decodeImage(file);
    if (text) showScanResult(text);
    else setScanStatus('No QR code found in that image. Try a sharper or closer picture.');
  } catch (err) {
    console.warn(err);
    setScanStatus('Couldn’t read that image.');
  }
}

/** Put a scanned code into the library and open it for editing. */
function addScanned(type: QrTypeId, fields: Fields): void {
  if (!confirmDiscard()) return;
  const def = TYPE_BY_ID[type];
  const full = { ...def.defaults, ...fields };
  let payload: string;
  try {
    payload = def.encode(full);
    makeMatrix(payload, DEFAULT_STYLE.ec);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Couldn’t use that code.');
    return;
  }
  const { list, id, ok } = addToHistory(
    {
      type,
      fields: full,
      style: { ...DEFAULT_STYLE },
      description: '',
      showDescription: true,
      showDecoded: false,
      payload,
    },
    { source: 'scan' },
  );
  history = list;
  if (!ok) toast('Storage is full — delete some codes first.');
  scanDialog.close();
  const entry = history.find((e) => e.id === id);
  if (entry) {
    loadIntoEditor(entry);
    toast('Added to your library. Edit away — changes save to this code.');
  }
}

function bindScanner(): void {
  $('scan-open').addEventListener('click', openScanner);
  $('history-scan').addEventListener('click', openScanner);
  $('scan-close').addEventListener('click', () => scanDialog.close());
  scanDialog.addEventListener('close', () => scanner?.stop());

  $('scan-switch').addEventListener('click', async () => {
    const cams = await listCameras().catch(() => []);
    if (cams.length < 2) return;
    const i = cams.findIndex((c) => c.deviceId === scanner?.deviceId);
    void startCamera(cams[(i + 1) % cams.length].deviceId);
  });

  const fileInput = $<HTMLInputElement>('scan-file');
  $('scan-file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void scanFile(file);
  });
  scanDialog.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) {
      e.preventDefault();
      void scanFile(file);
    }
  });

  $('scan-again').addEventListener('click', () => {
    scanned = null;
    $('scan-live').hidden = false;
    $('scan-result').hidden = true;
    void startCamera(scanner?.deviceId);
  });
  $('scan-accept').addEventListener('click', () => scanned && addScanned(scanned.parsed.type, scanned.parsed.fields));
  $('scan-as-text').addEventListener('click', () => scanned && addScanned('text', { text: scanned.payload }));
}

// ---------- views ----------

function showView(view: 'create' | 'history'): void {
  $('view-create').hidden = view !== 'create';
  $('view-history').hidden = view !== 'history';
  $('tab-create').setAttribute('aria-selected', String(view === 'create'));
  $('tab-history').setAttribute('aria-selected', String(view === 'history'));
  if (view === 'history') renderHistory(true);
  else if (current) paintPreview();
}

// ---------- PWA ----------

function setupPwa(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      toast('A new version is available.', { action: 'Reload', onAction: () => updateSW(true), duration: Infinity });
    },
    onOfflineReady() {
      toast('Ready to work offline.');
    },
  });

  let deferred: (Event & { prompt(): Promise<void> }) | null = null;
  const installBtn = $<HTMLButtonElement>('install-btn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as Event & { prompt(): Promise<void> };
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    installBtn.hidden = true;
    await deferred?.prompt();
    deferred = null;
  });
  window.addEventListener('appinstalled', () => (installBtn.hidden = true));

  const status = $('offline-status');
  const sync = () => (status.textContent = navigator.onLine ? '' : 'Offline — everything still works.');
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  sync();
}

// ---------- init ----------

$('app-version').textContent = `v${__APP_VERSION__}`;
$('app-version').title = `QR Code Builder version ${__APP_VERSION__}`;

buildTypePicker();
syncTypePicker();
buildFields();
syncControls();
bindControls();
bindExports();
bindHistory();
bindScanner();
$('tab-create').addEventListener('click', () => showView('create'));
$('tab-history').addEventListener('click', () => showView('history'));
renderHistoryCount();
setupPwa();
update();
