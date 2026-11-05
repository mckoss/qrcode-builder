import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { CapacityError, makeMatrix, type EcLevel, type Matrix } from './qr';
import { QR_TYPES, TYPE_BY_ID, ValidationError, type FieldDef, type QrTypeDef } from './qrtypes';
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
import {
  addToHistory,
  clearHistory,
  exportHistory,
  HISTORY_LIMIT,
  historyBytes,
  importHistory,
  loadDraft,
  loadHistory,
  removeEntry,
  restoreEntry,
  saveDraft,
  updateEntry,
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

function recordHistory(): void {
  if (!current) return;
  const { list, ok } = addToHistory({
    type: current.def.id,
    fields: draft.data[current.def.id],
    style: { ...draft.style },
    description: draft.description,
    showDescription: draft.showDescription,
    showDecoded: draft.showDecoded,
    payload: current.payload,
  });
  history = list;
  if (!ok) toast('Storage is full — couldn’t save to history. Delete some entries.');
  renderHistoryCount();
  // Ask the browser not to evict our storage (best effort, silent).
  navigator.storage?.persist?.().catch(() => {});
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
    recordHistory();
    toast('Saved to history.');
  });
}

// ---------- history view ----------

const historyList = $('history-list');
const historySearch = $<HTMLInputElement>('history-search');

function renderHistoryCount(): void {
  $('history-count').textContent = history.length ? String(history.length) : '';
}

function entryLabel(e: HistoryEntry): string {
  return e.description.trim().split('\n')[0] || TYPE_BY_ID[e.type].summary(e.fields);
}

function renderHistory(): void {
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
  $('storage-usage').textContent = `${history.length} of ${HISTORY_LIMIT} · ${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  $('history-empty').hidden = items.length > 0;
  $('history-empty').textContent = history.length ? 'No matches.' : 'No saved codes yet.';

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  historyList.replaceChildren(
    ...items.map((e) => {
      const canvas = h('canvas');
      try {
        renderThumb(canvas, makeMatrix(e.payload, e.style.ec), e.style, Math.round(84 * dpr));
      } catch {
        /* unrenderable entry: leave blank */
      }
      const date = new Date(e.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      return h(
        'li',
        { class: 'history-item' },
        h(
          'button',
          { type: 'button', class: 'thumb', title: 'Open', 'aria-label': `Open ${entryLabel(e)}`, onclick: () => openEntry(e) },
          canvas,
        ),
        h(
          'div',
          { class: 'history-body' },
          h('div', { class: 'history-title', title: entryLabel(e), text: (e.pinned ? '📌 ' : '') + entryLabel(e) }),
          h('div', { class: 'history-sub', text: `${TYPE_BY_ID[e.type].label} · ${date}` }),
          h('div', { class: 'history-sub', title: e.payload, text: e.payload.replace(/\s+/g, ' ') }),
          h(
            'div',
            { class: 'history-actions' },
            h('button', { type: 'button', class: 'btn', text: 'Open', onclick: () => openEntry(e) }),
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
                history = removeEntry(e.id);
                renderHistory();
                toast('Deleted.', {
                  action: 'Undo',
                  duration: 6000,
                  onAction: () => {
                    history = restoreEntry(e);
                    renderHistory();
                  },
                });
              },
            }),
          ),
        ),
      );
    }),
  );
}

function openEntry(e: HistoryEntry): void {
  draft.type = e.type;
  draft.data[e.type] = { ...e.fields };
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

function bindHistory(): void {
  historySearch.addEventListener('input', renderHistory);

  $('history-export').addEventListener('click', () => {
    const date = new Date().toISOString().slice(0, 10);
    download(new Blob([exportHistory()], { type: 'application/json' }), `qr-history-${date}.json`);
  });

  const fileInput = $<HTMLInputElement>('history-file');
  $('history-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const { added, list } = importHistory(await file.text());
      history = list;
      renderHistory();
      toast(added ? `Imported ${added} code${added === 1 ? '' : 's'}.` : 'Nothing new to import.');
    } catch (err) {
      toast(err instanceof Error && err.message.startsWith('No QR') ? err.message : 'That file isn’t a history export.');
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
      toast('History cleared.');
    }
  });

  // Keep in sync if another tab changes storage.
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('qrb.history')) {
      history = loadHistory();
      if (!$('view-history').hidden) renderHistory();
      else renderHistoryCount();
    }
  });
}

// ---------- views ----------

function showView(view: 'create' | 'history'): void {
  $('view-create').hidden = view !== 'create';
  $('view-history').hidden = view !== 'history';
  $('tab-create').setAttribute('aria-selected', String(view === 'create'));
  $('tab-history').setAttribute('aria-selected', String(view === 'history'));
  if (view === 'history') renderHistory();
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

buildTypePicker();
syncTypePicker();
buildFields();
syncControls();
bindControls();
bindExports();
bindHistory();
$('tab-create').addEventListener('click', () => showView('create'));
$('tab-history').addEventListener('click', () => showView('history'));
renderHistoryCount();
setupPwa();
update();
