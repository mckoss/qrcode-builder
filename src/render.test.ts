import { describe, expect, it } from 'vitest';
import { makeMatrix, darkRuns, CapacityError } from './qr';
import { computeLayout, contrastRatio, renderSvg, wrapText, type Measure } from './render';

// Monospace-ish fake measurement: 1 unit per character.
const charMeasure = (s: string) => s.length;
const measure: Measure = (s, _k, size) => s.length * size * 0.6;

describe('wrapText', () => {
  it('wraps on word boundaries', () => {
    expect(wrapText('the quick brown fox', 10, charMeasure)).toEqual(['the quick', 'brown fox']);
  });
  it('breaks long words', () => {
    expect(wrapText('abcdefghijkl', 5, charMeasure)).toEqual(['abcde', 'fghij', 'kl']);
  });
  it('keeps explicit and inner blank lines', () => {
    expect(wrapText('a\n\nb', 10, charMeasure)).toEqual(['a', '', 'b']);
    expect(wrapText('\n\na\n\n', 10, charMeasure)).toEqual(['a']);
  });
});

describe('matrix', () => {
  it('encodes and reports version', () => {
    const m = makeMatrix('hello', 'M');
    expect(m.version).toBe(1);
    expect(m.size).toBe(21);
    // Top-left finder pattern corner is dark.
    expect(m.isDark(0, 0)).toBe(true);
    expect(darkRuns(m).length).toBeGreaterThan(0);
  });
  it('raises CapacityError when too large', () => {
    expect(() => makeMatrix('x'.repeat(4000), 'H')).toThrow(CapacityError);
  });
});

describe('layout', () => {
  it('is exactly the QR when no text', () => {
    const L = computeLayout(21, 4, 290, { description: '', decoded: '' }, measure);
    expect(L.width).toBe(290);
    expect(L.height).toBe(290);
    expect(L.qrTop).toBe(0);
    expect(L.module).toBe(10);
  });
  it('adds text above and below', () => {
    const L = computeLayout(21, 4, 290, { description: 'Guest', decoded: 'Network: x' }, measure);
    expect(L.qrTop).toBeGreaterThan(0);
    expect(L.height).toBeGreaterThan(L.qrTop + 290);
    expect(L.blocks.map((b) => b.kind)).toEqual(['description', 'decoded']);
  });
});

describe('svg', () => {
  it('omits background when transparent and escapes text', () => {
    const m = makeMatrix('hi', 'L');
    const style = { fg: '#112233', bg: '#ffffff', transparent: true, ec: 'L' as const, margin: 2 };
    const svg = renderSvg(m, style, { description: 'A & <B>', decoded: '' }, measure);
    expect(svg).not.toContain('<rect');
    expect(svg).toContain('fill="#112233"');
    expect(svg).toContain('A &amp; &lt;B&gt;');
    const solid = renderSvg(m, { ...style, transparent: false }, { description: '', decoded: '' }, measure);
    expect(solid).toContain('<rect width="100%" height="100%" fill="#ffffff"/>');
  });
});

describe('contrast', () => {
  it('black on white is 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
});
