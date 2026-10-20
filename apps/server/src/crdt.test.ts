import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

function merge(left: Y.Doc, right: Y.Doc) {
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
}

describe('Yjs collaboration semantics', () => {
  it('converges independent concurrent insertions and tolerates duplicate delivery', () => {
    const a = new Y.Doc(); const b = new Y.Doc();
    a.getText('content').insert(0, 'Alpha'); b.getText('content').insert(0, 'Beta');
    const updateA = Y.encodeStateAsUpdate(a); const updateB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, updateB); Y.applyUpdate(a, updateB); Y.applyUpdate(b, updateA); Y.applyUpdate(b, updateA);
    expect(a.getText('content').toString()).toBe(b.getText('content').toString());
    expect(a.getText('content').length).toBe('Alpha'.length + 'Beta'.length);
    a.destroy(); b.destroy();
  });

  it('merges offline local changes with remote changes instead of replacing either side', () => {
    const server = new Y.Doc(); server.getText('content').insert(0, 'Shared ');
    const local = new Y.Doc(); Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
    const offlineUpdate: Uint8Array[] = [];
    local.on('update', update => offlineUpdate.push(update));
    local.getText('content').insert(7, 'local');
    server.getText('content').insert(7, 'remote ');
    Y.applyUpdate(server, Y.mergeUpdates(offlineUpdate));
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
    expect(local.getText('content').toString()).toBe(server.getText('content').toString());
    expect(server.getText('content').toString()).toContain('local');
    expect(server.getText('content').toString()).toContain('remote');
    local.destroy(); server.destroy();
  });

  it('reconstructs a document by applying its checkpoint and later updates', () => {
    const original = new Y.Doc(); original.getText('content').insert(0, 'Before');
    const snapshot = Y.encodeStateAsUpdate(original); original.getText('content').insert(6, ' and after');
    const tail = Y.encodeStateAsUpdate(original, Y.encodeStateVectorFromUpdate(snapshot));
    const recovered = new Y.Doc(); Y.applyUpdate(recovered, snapshot); Y.applyUpdate(recovered, tail);
    expect(recovered.getText('content').toString()).toBe('Before and after');
    original.destroy(); recovered.destroy();
  });

  it('converges deterministic out-of-order workloads with duplicate updates', () => {
    for (const seed of [17, 2026, 99173]) {
      const clients = Array.from({length:4},()=>new Y.Doc());
      const next = () => { seedState=(seedState*48271)%2147483647; return seedState; };
      let seedState=seed;
      for(let i=0;i<clients.length;i++)clients[i]!.getText('content').insert(0,`c${i}-${next()} `);
      const updates=clients.map(client=>Y.encodeStateAsUpdate(client));
      for(let i=0;i<clients.length;i++){
        const order=[...updates].reverse();
        for(const update of order){Y.applyUpdate(clients[i]!,update);Y.applyUpdate(clients[i]!,update);}
      }
      const expected=clients[0]!.getText('content').toString();
      expect(clients.every(client=>client.getText('content').toString()===expected)).toBe(true);
      clients.forEach(client=>client.destroy());
    }
  });
});
