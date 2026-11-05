// Layout and rendering shared by the preview, PNG, SVG, and PDF outputs.
import { darkRuns, type EcLevel, type Matrix } from './qr';

export interface Style {
  /** Color of dark ("positive") modules and text. */
  fg: string;
  bg: string;
  transparent: boolean;
  ec: EcLevel;
  /** Quiet zone in modules. */
  margin: number;
}

export interface TextSpec {
  /** Empty string = omitted. */
  description: string;
  decoded: string;
}

export type TextKind = 'description' | 'decoded';
export type Measure = (text: string, kind: TextKind, size: number) => number;

export interface TextBlock {
  kind: TextKind;
  lines: string[];
  size: number;
  lineHeight: number;
  top: number;
}

export interface Layout {
  width: number;
  height: number;
  qrTop: number;
  qrSide: number;
  module: number;
  margin: number;
  blocks: TextBlock[];
}

export const FONT_STACK = {
  description: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  decoded: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};

export function cssFont(kind: TextKind, size: number): string {
  return kind === 'description' ? `600 ${size}px ${FONT_STACK.description}` : `${size}px ${FONT_STACK.decoded}`;
}

/** Greedy word wrap; words wider than maxWidth are broken by character. Blank lines are kept. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    const push = () => {
      out.push(line.trimEnd());
      line = '';
    };
    for (const tok of para.split(/(\s+)/).filter(Boolean)) {
      if (/^\s+$/.test(tok)) {
        if (line) line += tok;
        continue;
      }
      if (measure(line + tok) <= maxWidth) {
        line += tok;
        continue;
      }
      if (line) push();
      if (measure(tok) <= maxWidth) {
        line = tok;
        continue;
      }
      for (const ch of Array.from(tok)) {
        if (line && measure(line + ch) > maxWidth) push();
        line += ch;
      }
    }
    push();
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

export function computeLayout(
  matrixSize: number,
  margin: number,
  qrSide: number,
  text: TextSpec,
  measure: Measure,
): Layout {
  const cells = matrixSize + 2 * margin;
  const module = qrSide / cells;
  const quiet = margin * module;
  const sep = Math.max(qrSide * 0.045 - quiet, 0);
  const edge = Math.max(quiet, qrSide * 0.03);
  const wrapWidth = qrSide * 0.9;
  const blocks: TextBlock[] = [];

  const block = (kind: TextKind, content: string, size: number): TextBlock | null => {
    const lines = wrapText(content, wrapWidth, (s) => measure(s, kind, size));
    return lines.length ? { kind, lines, size, lineHeight: size * 1.3, top: 0 } : null;
  };

  let y = 0;
  const desc = text.description.trim() ? block('description', text.description, qrSide * 0.068) : null;
  if (desc) {
    y = edge;
    desc.top = y;
    y += desc.lines.length * desc.lineHeight + sep;
    blocks.push(desc);
  }
  const qrTop = y;
  y += qrSide;
  const dec = text.decoded.trim() ? block('decoded', text.decoded, qrSide * 0.05) : null;
  if (dec) {
    y += sep;
    dec.top = y;
    y += dec.lines.length * dec.lineHeight + edge;
    blocks.push(dec);
  }
  return { width: qrSide, height: y, qrTop, qrSide, module, margin, blocks };
}

// ---------- canvas ----------

let measureCtx: CanvasRenderingContext2D | null = null;

export function canvasMeasure(): Measure {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  const ctx = measureCtx;
  return (t, kind, size) => {
    ctx.font = cssFont(kind, size);
    return ctx.measureText(t).width;
  };
}

/** Render to a canvas whose width is exactly `widthPx`. Modules are snapped to whole pixels. */
export function renderCanvas(
  canvas: HTMLCanvasElement,
  matrix: Matrix,
  style: Style,
  text: TextSpec,
  widthPx: number,
): Layout {
  const L = computeLayout(matrix.size, style.margin, widthPx, text, canvasMeasure());
  canvas.width = Math.round(L.width);
  canvas.height = Math.ceil(L.height);
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!style.transparent) {
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = style.fg;
  const m = L.module;
  const off = style.margin;
  for (const [r, c0, c1] of darkRuns(matrix)) {
    const x0 = Math.round((off + c0) * m);
    const x1 = Math.round((off + c1) * m);
    const y0 = Math.round(L.qrTop + (off + r) * m);
    const y1 = Math.round(L.qrTop + (off + r + 1) * m);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of L.blocks) {
    ctx.font = cssFont(b.kind, b.size);
    b.lines.forEach((line, i) => ctx.fillText(line, L.width / 2, b.top + b.lineHeight * (i + 0.5)));
  }
  return L;
}

/** Small QR-only thumbnail (no text). */
export function renderThumb(canvas: HTMLCanvasElement, matrix: Matrix, style: Style, sizePx: number): void {
  renderCanvas(canvas, matrix, style, { description: '', decoded: '' }, sizePx);
}

// ---------- SVG ----------

const xmlEsc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

const r2 = (n: number) => Math.round(n * 100) / 100;

export function renderSvg(matrix: Matrix, style: Style, text: TextSpec, measure: Measure): string {
  const unit = 10;
  const cells = matrix.size + 2 * style.margin;
  const L = computeLayout(matrix.size, style.margin, cells * unit, text, measure);
  const W = r2(L.width);
  const H = r2(L.height);
  let d = '';
  for (const [r, c0, c1] of darkRuns(matrix)) {
    d += `M${(style.margin + c0) * unit} ${r2(L.qrTop + (style.margin + r) * unit)}h${(c1 - c0) * unit}v${unit}h-${(c1 - c0) * unit}z`;
  }
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  ];
  if (!style.transparent) parts.push(`<rect width="100%" height="100%" fill="${xmlEsc(style.bg)}"/>`);
  parts.push(`<path fill="${xmlEsc(style.fg)}" shape-rendering="crispEdges" d="${d}"/>`);
  for (const b of L.blocks) {
    const weight = b.kind === 'description' ? ' font-weight="600"' : '';
    parts.push(
      `<g fill="${xmlEsc(style.fg)}" font-family="${xmlEsc(FONT_STACK[b.kind])}" font-size="${r2(b.size)}"${weight} text-anchor="middle" dominant-baseline="central">`,
    );
    b.lines.forEach((line, i) => {
      parts.push(
        `<text x="${r2(W / 2)}" y="${r2(b.top + b.lineHeight * (i + 0.5))}" xml:space="preserve">${xmlEsc(line)}</text>`,
      );
    });
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ---------- color helpers ----------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
