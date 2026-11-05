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

  it('prunes oldest unpinned beyond the limit', () => {
    store.addToHistory(item('keep'));
    const keep = store.loadHistory()[0];
    store.updateEntry(keep.id, { pinned: true });
    for (let i = 0; i < store.HISTORY_LIMIT + 5; i++) store.addToHistory(item(`x${i}`));
    const list = store.loadHistory();
    expect(list).toHaveLength(store.HISTORY_LIMIT);
    expect(list.some((e) => e.payload === 'keep')).toBe(true);
    expect(list.some((e) => e.payload === 'x0')).toBe(false);
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
    localStorage.setItem('qrb.history.v1', '{not json');
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
