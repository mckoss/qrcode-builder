import { describe, expect, it } from 'vitest';
import { parsePayload } from './parse';
import { TYPE_BY_ID, type Fields, type QrTypeId } from './qrtypes';

/** encode → parse should give back the same type and fields. */
function roundTrip(type: QrTypeId, fields: Fields) {
  const def = TYPE_BY_ID[type];
  const full = { ...def.defaults, ...fields };
  const payload = def.encode(full);
  const parsed = parsePayload(payload);
  expect(parsed.type).toBe(type);
  expect(parsed.dropped).toEqual([]);
  expect(def.encode(parsed.fields)).toBe(payload);
  return parsed.fields;
}

describe('round trips', () => {
  it('wifi', () => {
    expect(roundTrip('wifi', { ssid: 'My;Net:"x"\\', password: 'p,a;s:s', hidden: true })).toMatchObject({
      ssid: 'My;Net:"x"\\',
      password: 'p,a;s:s',
      hidden: true,
      security: 'WPA',
    });
    roundTrip('wifi', { ssid: 'Cafe', security: 'nopass' });
    roundTrip('wifi', { ssid: 'Old', security: 'WEP', password: '12345' });
  });
  it('text, url, email, phone, sms, geo', () => {
    roundTrip('url', { url: 'https://example.com/a?b=c&d=e' });
    roundTrip('email', { to: 'a@b.com', subject: 'Hi & bye', body: 'Line 1\nLine 2 +x' });
    roundTrip('phone', { number: '+15551234567' });
    roundTrip('sms', { number: '+15551234', message: 'See you: soon' });
    roundTrip('geo', { lat: '47.6205', lng: '-122.3493' });
  });
  it('vcard', () => {
    roundTrip('vcard', {
      first: 'Ada',
      last: 'Lovelace',
      org: 'Analytical, Inc.',
      title: 'Countess; Mathematician',
      phone: '+44201234',
      email: 'ada@example.com',
      url: 'https://example.com',
      street: '12 St. James’s Sq',
      city: 'London',
      postcode: 'SW1',
      country: 'UK',
      note: 'line1\nline2',
    });
  });
  it('event (timed and all-day)', () => {
    roundTrip('event', { title: 'Party, 2026', start: '2026-11-05T18:30', end: '2026-11-05T21:00', location: 'Home' });
    roundTrip('event', { title: 'Trip', allDay: true, startDate: '2026-12-30', endDate: '2027-01-02' });
    roundTrip('event', { title: 'Day', allDay: true, startDate: '2026-12-30' });
  });
});

describe('codes from other generators', () => {
  it('wifi with any field order, WPA2 and quoted SSID', () => {
    const p = parsePayload('WIFI:S:"Home Net";T:WPA2;P:secret;H:false;;');
    expect(p.type).toBe('wifi');
    expect(p.fields).toMatchObject({ ssid: 'Home Net', security: 'WPA', password: 'secret', hidden: false });
  });
  it('wifi enterprise settings are reported as dropped', () => {
    const p = parsePayload('WIFI:T:WPA2-EAP;S:Corp;P:pw;E:PEAP;I:user;;');
    expect(p.type).toBe('wifi');
    expect(p.dropped.length).toBeGreaterThan(0);
  });
  it('wifi without SSID stays text', () => {
    expect(parsePayload('WIFI:T:WPA;P:x;;').type).toBe('text');
  });
  it('sms: URI form and SMSTO', () => {
    expect(parsePayload('sms:+15551234?body=Hello%20there').fields).toMatchObject({
      number: '+15551234',
      message: 'Hello there',
    });
    expect(parsePayload('smsto:555:hi').fields).toMatchObject({ number: '555', message: 'hi' });
  });
  it('mailto with cc reports dropped', () => {
    const p = parsePayload('mailto:a@b.com?cc=c@d.com&subject=Yo');
    expect(p.fields).toMatchObject({ to: 'a@b.com', subject: 'Yo' });
    expect(p.dropped).toEqual(['cc']);
  });
  it('MATMSG email', () => {
    expect(parsePayload('MATMSG:TO:a@b.com;SUB:Hi;BODY:There;;').fields).toMatchObject({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'There',
    });
  });
  it('vCard 2.1 with folding, groups, quoted-printable and extras', () => {
    const v = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N:Doe;Jane;Q;;',
      'FN:Jane Doe',
      'item1.TEL;CELL:+1 555 0100',
      'TEL;WORK:+1 555 0199',
      'EMAIL;INTERNET:jane@exa',
      ' mple.com',
      'NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Caf=C3=A9',
      'BDAY:1990-01-01',
      'END:VCARD',
    ].join('\r\n');
    const p = parsePayload(v);
    expect(p.type).toBe('vcard');
    expect(p.fields).toMatchObject({ first: 'Jane', last: 'Doe', phone: '+1 555 0100', email: 'jane@example.com', note: 'Café' });
    expect(p.dropped).toEqual(expect.arrayContaining(['middle name / prefix / suffix', 'additional phone', 'bday']));
  });
  it('MECARD', () => {
    const p = parsePayload('MECARD:N:Doe,John;TEL:5551234;EMAIL:j@d.com;;');
    expect(p.type).toBe('vcard');
    expect(p.fields).toMatchObject({ first: 'John', last: 'Doe', phone: '5551234', email: 'j@d.com' });
  });
  it('VCALENDAR-wrapped event with extra properties', () => {
    const v = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:123',
      'SUMMARY:Launch\\, party',
      'DTSTART:20261201T170000Z',
      'DTEND:20261201T190000Z',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');
    const p = parsePayload(v);
    expect(p.type).toBe('event');
    expect(p.fields).toMatchObject({ title: 'Launch, party', start: '2026-12-01T17:00', end: '2026-12-01T19:00' });
    expect(p.dropped).toEqual(['rrule']);
  });
  it('geo with altitude and label', () => {
    const p = parsePayload('geo:1.5,2.5,100?q=Here');
    expect(p.type).toBe('geo');
    expect(p.dropped).toHaveLength(2);
  });
  it('plain text and scheme-less URLs stay text', () => {
    expect(parsePayload('hello world').type).toBe('text');
    expect(parsePayload('www.example.com').type).toBe('text');
    expect(parsePayload('https://a.b c').type).toBe('text');
    expect(parsePayload('HTTPS://EXAMPLE.COM').type).toBe('url');
  });
});
