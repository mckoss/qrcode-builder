import { describe, expect, it } from 'vitest';
import { escapeVText, escapeWifi, TYPE_BY_ID, ValidationError } from './qrtypes';

const enc = (id: keyof typeof TYPE_BY_ID, f: Record<string, string | boolean>) =>
  TYPE_BY_ID[id].encode({ ...TYPE_BY_ID[id].defaults, ...f });

describe('wifi', () => {
  it('encodes WPA by default', () => {
    expect(enc('wifi', { ssid: 'Home', password: 'secret123' })).toBe('WIFI:T:WPA;S:Home;P:secret123;;');
  });
  it('escapes special characters', () => {
    expect(escapeWifi('a;b,c:d"e\\f')).toBe('a\\;b\\,c\\:d\\"e\\\\f');
    expect(enc('wifi', { ssid: 'My;Net', password: 'p:w' })).toBe('WIFI:T:WPA;S:My\\;Net;P:p\\:w;;');
  });
  it('keeps leading/trailing spaces in SSID and password', () => {
    expect(enc('wifi', { ssid: ' x ', password: ' pw ' })).toBe('WIFI:T:WPA;S: x ;P: pw ;;');
  });
  it('supports open and hidden networks', () => {
    expect(enc('wifi', { ssid: 'Cafe', security: 'nopass', password: 'ignored' })).toBe('WIFI:T:nopass;S:Cafe;;');
    expect(enc('wifi', { ssid: 'H', password: 'x', hidden: true })).toBe('WIFI:T:WPA;S:H;P:x;H:true;;');
    expect(enc('wifi', { ssid: 'W', security: 'WEP', password: 'abcde' })).toBe('WIFI:T:WEP;S:W;P:abcde;;');
  });
  it('requires SSID and password', () => {
    expect(() => enc('wifi', { ssid: '' })).toThrow(ValidationError);
    expect(() => enc('wifi', { ssid: 'x', password: '' })).toThrow(ValidationError);
  });
  it('produces readable decoded text', () => {
    const d = TYPE_BY_ID.wifi.decoded({ ssid: 'Home', password: 'pw', security: 'WPA' });
    expect(d).toBe('Network: Home\nPassword: pw');
    expect(TYPE_BY_ID.wifi.decoded({ ssid: 'Cafe', security: 'nopass' })).toContain('Open network');
  });
});

describe('simple types', () => {
  it('text is encoded verbatim', () => {
    expect(enc('text', { text: '  hi\nthere ' })).toBe('  hi\nthere ');
  });
  it('url gets https:// when missing', () => {
    expect(enc('url', { url: 'example.com/x' })).toBe('https://example.com/x');
    expect(enc('url', { url: 'http://a.b' })).toBe('http://a.b');
  });
  it('email builds mailto', () => {
    expect(enc('email', { to: 'a@b.com', subject: 'Hi there', body: 'x&y' })).toBe(
      'mailto:a@b.com?subject=Hi%20there&body=x%26y',
    );
    expect(enc('email', { to: 'a@b.com' })).toBe('mailto:a@b.com');
  });
  it('phone and sms', () => {
    expect(enc('phone', { number: '+1 (555) 123-4567' })).toBe('tel:+15551234567');
    expect(enc('sms', { number: '555 1234', message: 'Hello: world' })).toBe('SMSTO:5551234:Hello: world');
    expect(() => enc('phone', { number: 'abc' })).toThrow(ValidationError);
  });
  it('geo validates ranges', () => {
    expect(enc('geo', { lat: '47.6205', lng: '-122.3493' })).toBe('geo:47.6205,-122.3493');
    expect(() => enc('geo', { lat: '91', lng: '0' })).toThrow(ValidationError);
    expect(() => enc('geo', { lat: '', lng: '0' })).toThrow(ValidationError);
  });
});

describe('vcard', () => {
  it('builds a vCard 3.0 with escaping', () => {
    const v = enc('vcard', {
      first: 'Ada',
      last: 'Lovelace',
      org: 'Analytical, Inc.',
      phone: '+44 20 1234',
      email: 'ada@example.com',
      url: 'example.com',
      city: 'London',
      note: 'line1\nline2',
    });
    expect(v.split('\r\n')).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Lovelace;Ada;;;',
      'FN:Ada Lovelace',
      'ORG:Analytical\\, Inc.',
      'TEL;TYPE=CELL:+44201234',
      'EMAIL:ada@example.com',
      'URL:https://example.com',
      'ADR;TYPE=WORK:;;;London;;;',
      'NOTE:line1\\nline2',
      'END:VCARD',
    ]);
  });
  it('requires a name or organization', () => {
    expect(() => enc('vcard', { email: 'x@y.z' })).toThrow(ValidationError);
  });
  it('escapeVText', () => {
    expect(escapeVText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });
});

describe('event', () => {
  it('encodes timed events in UTC (TZ=UTC in tests)', () => {
    const v = enc('event', { title: 'Party', start: '2026-11-05T18:30', end: '2026-11-05T21:00', location: 'Home' });
    expect(v.split('\r\n')).toEqual([
      'BEGIN:VEVENT',
      'SUMMARY:Party',
      'DTSTART:20261105T183000Z',
      'DTEND:20261105T210000Z',
      'LOCATION:Home',
      'END:VEVENT',
    ]);
  });
  it('encodes all-day events with exclusive end date', () => {
    const v = enc('event', { title: 'Trip', allDay: true, startDate: '2026-12-30', endDate: '2026-12-31' });
    expect(v).toContain('DTSTART;VALUE=DATE:20261230');
    expect(v).toContain('DTEND;VALUE=DATE:20270101');
  });
  it('rejects end before start', () => {
    expect(() => enc('event', { title: 'x', start: '2026-11-05T18:30', end: '2026-11-05T17:00' })).toThrow(
      ValidationError,
    );
  });
});
