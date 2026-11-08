import { describe, expect, it } from 'vitest';
import { decodeRegion, DIGITAL_ZOOM_MAX, FRAME_FRACTION, nearestToCenter, splitZoom, zoomRange } from './scan';

describe('zoom', () => {
  const hw = { min: 1, max: 5, step: 0.1 };

  it('uses the camera zoom first, then digital zoom on top', () => {
    expect(splitZoom(3, hw)).toEqual({ hardware: 3, digital: 1 });
    expect(splitZoom(8, hw)).toEqual({ hardware: 5, digital: 1.6 });
    expect(splitZoom(100, hw)).toEqual({ hardware: 5, digital: DIGITAL_ZOOM_MAX });
    expect(splitZoom(2.03, hw)).toEqual({ hardware: 2.0, digital: 1 }); // rounded to the camera's step
  });

  it('is digital only when the camera has no zoom', () => {
    expect(splitZoom(2.5, null)).toEqual({ hardware: null, digital: 2.5 });
    expect(splitZoom(0.5, null)).toEqual({ hardware: null, digital: 1 });
    expect(zoomRange(null)).toEqual({ min: 1, max: DIGITAL_ZOOM_MAX });
    expect(zoomRange(hw)).toEqual({ min: 1, max: 5 * DIGITAL_ZOOM_MAX });
  });

  it('decodes the viewfinder square, shrinking with digital zoom', () => {
    const video = { width: 1920, height: 1080 };
    const view = { width: 400, height: 300 }; // 4:3 view of a 16:9 video (object-fit: cover)
    const scale = Math.max(400 / 1920, 300 / 1080); // css px per video px
    const r1 = decodeRegion(video, view, 1);
    expect(r1.size).toBeCloseTo((300 * FRAME_FRACTION * 1.1) / scale, 5);
    expect(r1.x + r1.size / 2).toBeCloseTo(960, 5); // centered
    expect(r1.y + r1.size / 2).toBeCloseTo(540, 5);
    expect(decodeRegion(video, view, 2).size).toBeCloseTo(r1.size / 2, 5);
    // Never larger than the frame itself.
    expect(decodeRegion({ width: 100, height: 80 }, view, 1).size).toBeLessThanOrEqual(80);
  });
});

describe('nearestToCenter', () => {
  it('picks the code closest to the middle of the image', () => {
    const box = (x: number, y: number) => ({ x, y, width: 50, height: 50 });
    const codes = [
      { rawValue: 'corner', boundingBox: box(0, 0) },
      { rawValue: 'middle', boundingBox: box(180, 130) },
      { rawValue: 'edge', boundingBox: box(350, 120) },
    ];
    expect(nearestToCenter(codes, { width: 400, height: 300 }).rawValue).toBe('middle');
  });
});
