import QRCode from 'qrcode';

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface Matrix {
  /** Modules per side (excluding quiet zone). */
  size: number;
  version: number;
  ec: EcLevel;
  isDark(row: number, col: number): boolean;
}

export class CapacityError extends Error {}

/** Encode text (UTF-8, byte/alphanumeric/numeric segments chosen automatically). */
export function makeMatrix(text: string, ec: EcLevel): Matrix {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: ec });
    const m = qr.modules;
    return {
      size: m.size,
      version: qr.version,
      ec,
      isDark: (r, c) => !!m.get(r, c),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/too big|amount of data/i.test(msg)) {
      throw new CapacityError(
        ec === 'L'
          ? 'Too much content for a QR code. Shorten it.'
          : 'Too much content for this error-correction level. Shorten it or choose a lower level.',
      );
    }
    throw err;
  }
}

/** Horizontal runs of dark modules: [row, startCol, endColExclusive]. Merging runs avoids hairline seams. */
export function darkRuns(m: Matrix): [number, number, number][] {
  const runs: [number, number, number][] = [];
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < m.size && m.isDark(r, c)) c++;
      runs.push([r, start, c]);
    }
  }
  return runs;
}
