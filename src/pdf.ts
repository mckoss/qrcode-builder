// PDF export (lazy-loaded). Page is sized tightly to the content; modules are vector rectangles.
import { jsPDF } from 'jspdf';
import { darkRuns, type Matrix } from './qr';
import { canvasMeasure, computeLayout, cssFont, type Measure, type Style, type TextBlock, type TextKind, type TextSpec } from './render';

// The built-in PDF fonts only cover Latin-1. Other text is rendered to an image instead.
const LATIN1 = /^[\x20-\x7E\u00A0-\u00FF\r\n\t]*$/;

const PDF_FONT: Record<TextKind, [string, string]> = {
  description: ['helvetica', 'bold'],
  decoded: ['courier', 'normal'],
};

export function buildPdf(matrix: Matrix, style: Style, text: TextSpec, widthPt: number, title: string): Blob {
  // jsPDF needs a document to measure with; page size is fixed later via a fresh document.
  const probe = new jsPDF({ unit: 'pt' });
  const native: Record<TextKind, boolean> = {
    description: LATIN1.test(text.description),
    decoded: LATIN1.test(text.decoded),
  };
  const cm = canvasMeasure();
  const measure: Measure = (t, kind, size) => {
    if (!native[kind]) return cm(t, kind, size);
    probe.setFont(...PDF_FONT[kind]);
    probe.setFontSize(size);
    return probe.getTextWidth(t);
  };
  const L = computeLayout(matrix.size, style.margin, widthPt, text, measure);
  const W = L.width;
  const H = L.height;

  const doc = new jsPDF({
    unit: 'pt',
    format: [W, H],
    orientation: W > H ? 'landscape' : 'portrait',
    compress: true,
  });
  doc.setProperties({ title, creator: 'QR Code Builder' });

  if (!style.transparent) {
    doc.setFillColor(style.bg);
    doc.rect(0, 0, W, H, 'F');
  }

  doc.setFillColor(style.fg);
  const m = L.module;
  // Slight vertical overlap hides anti-aliasing seams between rows in some viewers.
  const overlap = m * 0.03;
  for (const [r, c0, c1] of darkRuns(matrix)) {
    doc.rect((style.margin + c0) * m, L.qrTop + (style.margin + r) * m, (c1 - c0) * m, m + overlap, 'F');
  }

  for (const b of L.blocks) {
    if (native[b.kind]) {
      doc.setFont(...PDF_FONT[b.kind]);
      doc.setFontSize(b.size);
      doc.setTextColor(style.fg);
      b.lines.forEach((line, i) => {
        if (line) doc.text(line, W / 2, b.top + b.lineHeight * (i + 0.5), { align: 'center', baseline: 'middle' });
      });
    } else {
      const img = textBlockImage(b, W, style.fg, 4);
      doc.addImage(img, 'PNG', 0, b.top, W, b.lines.length * b.lineHeight, undefined, 'FAST');
    }
  }
  return doc.output('blob');
}

function textBlockImage(b: TextBlock, width: number, color: string, scale: number): string {
  const c = document.createElement('canvas');
  c.width = Math.ceil(width * scale);
  c.height = Math.ceil(b.lines.length * b.lineHeight * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.font = cssFont(b.kind, b.size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  b.lines.forEach((line, i) => ctx.fillText(line, width / 2, b.lineHeight * (i + 0.5)));
  return c.toDataURL('image/png');
}
