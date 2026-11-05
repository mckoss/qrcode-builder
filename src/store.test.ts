import { beforeEach, describe, expect, it } from 'vitest';

// Minimal localStorage for the node test environment.
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const store = await import('./store');

const item = (payload: string) => ({
  type: 'text' as const,
  fields: { text: payload },
  style: { ...store.DEFAULT_STYLE },
  description: '',
  showDescription: true,
  showDecoded: false,
  payload,
});

describe('history', () => {
  beforeEach(() => localStorage.clear());

  it('adds and de-duplicates', () => {
    store.addToHistory(item('a'));
    store.addToHistory(item('b'));
    store.addToHistory(item('a'));
    const list = store.loadHistory();
    expect(list.map((e) => e.payload).sort()).toEqual(['a', 'b']);
  });

  it('treats different styles as different entries', () => {
    store.addToHistory(item('a'));
    store.addToHistory({ ...item('a'), style: { ...store.DEFAULT_STYLE, fg: '#ff0000' } });
    expect(store.loadHistory()).toHaveLength(2);
  });

  it('keeps every code: there is no count limit and nothing is pruned', () => {
    for (let i = 0; i < 1000; i++) store.addToHistory(item(`x${i}`));
    expect(store.loadHistory()).toHaveLength(1000);
  });

  it('stores only source data, compactly', () => {
    store.addToHistory({
      type: 'wifi',
      fields: { ssid: 'Office', security: 'WPA', password: 'hunter22', hidden: false },
      style: { ...store.DEFAULT_STYLE },
      description: '',
      showDescription: true,
      showDecoded: false,
      payload: 'WIFI:T:WPA;S:Office;P:hunter22;;',
    });
    const raw = localStorage.getItem('qrb.library.v2')!;
    const [rec] = JSON.parse(raw);
    expect(rec).not.toHaveProperty('payload');
    expect(rec.fields).toEqual({ ssid: 'Office', security: 'WPA', password: 'hunter22' });
    expect(rec).not.toHaveProperty('description');
    expect(rec).not.toHaveProperty('style'); // the standard look needs no bytes
    expect(raw.length).toBeLessThan(160);
    // The payload is regenerated from the fields on load.
    expect(store.loadHistory()[0].payload).toBe('WIFI:T:WPA;S:Office;P:hunter22;;');
  });

  it('round-trips non-default styles and options', () => {
    const style = { fg: '#1d4ed8', bg: '#fff3c4', transparent: false, ec: 'H' as const, margin: 0 };
    store.addToHistory({ ...item('styled'), style, description: 'D', showDescription: false, showDecoded: true });
    const [e] = store.loadHistory();
    expect(e).toMatchObject({ style, description: 'D', showDescription: false, showDecoded: true });
    expect(JSON.parse(localStorage.getItem('qrb.library.v2')!)[0].style).toEqual(style);
  });

  it('a large contact card still stays small', () => {
    const fields = {
      first: 'Augusta Ada',
      last: 'King-Noel',
      org: 'Analytical Engines Ltd',
      title: 'Countess of Lovelace',
      phone: '+44 20 7946 0958',
      email: 'ada@analytical.example',
      url: 'https://analytical.example',
      street: '12 St James Square',
      city: 'London',
      postcode: 'SW1Y 4JH',
      country: 'United Kingdom',
    };
    store.addToHistory({ ...item(''), type: 'vcard', fields, payload: '' });
    expect(localStorage.getItem('qrb.library.v2')!.length).toBeLessThan(500);
  });

  it('migrates the pre-1.2 format and frees the old copy', () => {
    const legacy = [
      {
        id: '0b7f0c1e-1111-4222-8333-944445555666',
        created: 1,
        updated: 2,
        type: 'url',
        fields: { url: 'example.com' },
        style: store.DEFAULT_STYLE,
        description: 'Site',
        showDescription: true,
        showDecoded: false,
        payload: 'https://example.com',
        pinned: true,
      },
    ];
    localStorage.setItem('qrb.history.v1', JSON.stringify(legacy));
    const [e] = store.loadHistory();
    expect(e).toMatchObject({ id: legacy[0].id, description: 'Site', pinned: true, payload: 'https://example.com' });
    expect(localStorage.getItem('qrb.history.v1')).toBeNull();
    expect(localStorage.getItem('qrb.library.v2')).not.toContain('payload');
  });

  it('reports a full storage without deleting anything', () => {
    store.addToHistory(item('kept'));
    const set = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    try {
      const r = store.addToHistory(item('new'));
      expect(r.ok).toBe(false);
      expect(r.list.map((e) => e.payload)).toEqual(['kept']);
    } finally {
      localStorage.setItem = set;
    }
  });

  it('removes, restores, and clears', () => {
    store.addToHistory(item('a'));
    const [e] = store.loadHistory();
    expect(store.removeEntry(e.id)).toHaveLength(0);
    expect(store.restoreEntry(e)).toHaveLength(1);
    store.updateEntry(e.id, { pinned: true });
    store.addToHistory(item('b'));
    expect(store.clearHistory(true).map((x) => x.payload)).toEqual(['a']);
    expect(store.clearHistory(false)).toHaveLength(0);
  });

  it('exports and imports', () => {
    store.addToHistory(item('a'));
    const json = store.exportHistory();
    localStorage.clear();
    expect(store.importHistory(json).added).toBe(1);
    expect(store.importHistory(json).added).toBe(0);
    expect(() => store.importHistory('{"foo":1}')).toThrow();
  });

  it('ignores corrupt data', () => {
    localStorage.setItem('qrb.library.v2', '{not json');
    expect(store.loadHistory()).toEqual([]);
    localStorage.setItem('qrb.draft.v1', JSON.stringify({ type: 'nope', style: { fg: 'red', margin: 99 } }));
    const d = store.loadDraft();
    expect(d.type).toBe('wifi');
    expect(d.style.fg).toBe('#000000');
    expect(d.style.margin).toBe(4);
  });

  it('revises entries in place, keeping identity, pin and source', () => {
    const { id } = store.addToHistory(item('v1'), { source: 'scan' });
    store.updateEntry(id, { pinned: true });
    const before = store.getEntry(id)!;
    const r = store.reviseEntry(id, { ...item('v2'), description: 'Renamed' });
    expect(r).not.toBeNull();
    const after = store.getEntry(id)!;
    expect(store.loadHistory()).toHaveLength(1);
    expect(after).toMatchObject({ id, payload: 'v2', description: 'Renamed', pinned: true, source: 'scan', created: before.created });
    expect(after.updated).toBeGreaterThan(before.updated);
    expect(store.reviseEntry('missing', item('x'))).toBeNull();
  });

  it('can save an identical copy when asked', () => {
    const a = store.addToHistory(item('same'));
    const b = store.addToHistory(item('same'), { dedupe: false });
    expect(a.id).not.toBe(b.id);
    expect(store.loadHistory()).toHaveLength(2);
    expect(store.addToHistory(item('same')).list).toHaveLength(2);
  });
});
