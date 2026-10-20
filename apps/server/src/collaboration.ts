import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Yjs from 'yjs';
import { pool } from './db.js';
import type { AuthUser } from './auth.js';

const SYNC = 0;
const AWARENESS = 1;
const rooms = new Map<string, Promise<Room>>();
const connections = new Map<string, Map<WebSocket, { userId: string; editable: boolean }>>();
let databaseHealthy = true;

class Room extends Yjs.Doc {
  readonly awareness = new awarenessProtocol.Awareness(this);
  readonly conns = new Map<WebSocket, Set<number>>();
  persistenceTail: Promise<void> = Promise.resolve();
  updatesSinceSnapshot = 0;

  constructor(readonly documentId: string) {
    super();
    this.awareness.setLocalState(null);
    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
      const changed = added.concat(updated, removed);
      if (origin && this.conns.has(origin as WebSocket)) {
        const controlled = this.conns.get(origin as WebSocket)!;
        for (const id of added) controlled.add(id);
        for (const id of removed) controlled.delete(id);
      }
      if (changed.length) {
        const message = encoding.createEncoder();
        encoding.writeVarUint(message, AWARENESS);
        encoding.writeVarUint8Array(message, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.conns.forEach((_ids, socket) => send(socket, encoding.toUint8Array(message)));
      }
    });
    this.on('update', (update: Uint8Array, origin: unknown) => {
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, SYNC);
      syncProtocol.writeUpdate(message, update);
      const bytes = encoding.toUint8Array(message);
      this.conns.forEach((_ids, socket) => { if (socket !== origin) send(socket, bytes); });
    });
  }
}

function send(socket: WebSocket, bytes: Uint8Array) {
  if (socket.readyState === 1) socket.send(bytes);
}

async function loadRoom(documentId: string): Promise<Room> {
  const room = new Room(documentId);
  try {
    const snapshot = await pool.query<{ state_bytes: Buffer; covered_sequence: string }>(
      'SELECT state_bytes,covered_sequence FROM document_snapshots WHERE document_id=$1 ORDER BY covered_sequence DESC LIMIT 1', [documentId],
    );
    const covered = snapshot.rows[0] ? Number(snapshot.rows[0].covered_sequence) : 0;
    if (snapshot.rows[0]) Yjs.applyUpdate(room, snapshot.rows[0].state_bytes, 'persistence');
    const updates = await pool.query<{ update_bytes: Buffer }>(
      'SELECT update_bytes FROM document_updates WHERE document_id=$1 AND sequence>$2 ORDER BY sequence', [documentId, covered],
    );
    for (const row of updates.rows) Yjs.applyUpdate(room, row.update_bytes, 'persistence');
    databaseHealthy = true;
    return room;
  } catch (error) {
    databaseHealthy = false;
    room.awareness.destroy(); room.destroy();
    throw error;
  }
}

function getRoom(documentId: string) {
  let room = rooms.get(documentId);
  if (!room) { room = loadRoom(documentId).catch(error=>{rooms.delete(documentId);throw error;}); rooms.set(documentId, room); }
  return room;
}

async function persistUpdate(room: Room, update: Uint8Array, origin: WebSocket) {
  const validation = new Yjs.Doc();
  try { Yjs.applyUpdate(validation, update); } finally { validation.destroy(); }
  const operation = room.persistenceTail.then(async () => {
    let client: import('pg').PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const next = await client.query<{ snapshot_version: string }>(
        'UPDATE documents SET snapshot_version=snapshot_version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING snapshot_version', [room.documentId],
      );
      if (!next.rowCount) throw new Error('Document is no longer available');
      await client.query('INSERT INTO document_updates(document_id,sequence,update_bytes) VALUES($1,$2,$3)', [room.documentId, next.rows[0]!.snapshot_version, Buffer.from(update)]);
      await client.query('COMMIT');
      databaseHealthy = true;
      // Room update listeners relay only after this transaction commits.
      Yjs.applyUpdate(room, update, origin);
      room.updatesSinceSnapshot++;
      if (room.updatesSinceSnapshot >= 100) await compact(room, client);
    } catch (error) {
      databaseHealthy = false;
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client?.release(); }
  });
  room.persistenceTail = operation.catch(() => {});
  return operation;
}

async function compact(room: Room, client: import('pg').PoolClient) {
  room.updatesSinceSnapshot = 0;
  await client.query('BEGIN');
  try {
    const row = await client.query<{ snapshot_version: string }>('SELECT snapshot_version FROM documents WHERE id=$1 FOR UPDATE', [room.documentId]);
    if (!row.rowCount) { await client.query('ROLLBACK'); return; }
    const checkpoint = row.rows[0]!.snapshot_version;
    await client.query('INSERT INTO document_snapshots(document_id,state_bytes,covered_sequence) VALUES($1,$2,$3) ON CONFLICT(document_id,covered_sequence) DO NOTHING',
      [room.documentId, Buffer.from(Yjs.encodeStateAsUpdate(room)), checkpoint]);
    await client.query('DELETE FROM document_updates WHERE document_id=$1 AND sequence<=$2', [room.documentId, checkpoint]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); databaseHealthy = false; throw error; }
}

export function persistenceIsHealthy() { return databaseHealthy; }

export function revokeRoomSockets(documentId: string, userId?: string) {
  const roomConnections = connections.get(documentId);
  if (!roomConnections) return;
  for (const [socket, info] of roomConnections) {
    if (!userId || info.userId === userId) socket.close(1008, 'Document access changed');
  }
}

export async function handleCollaborationSocket(
  socket: WebSocket,
  request: FastifyRequest,
  documentId: string,
  user: AuthUser,
  permission: 'read' | 'edit',
  allowedOrigin: string,
) {
  if (request.headers.origin !== allowedOrigin) { socket.close(1008, 'Origin is not allowed'); return; }
  let room: Room;
  try { room = await getRoom(documentId); } catch { socket.close(1013, 'Document could not be loaded'); return; }
  let roomSockets = connections.get(documentId);
  if (!roomSockets) { roomSockets = new Map(); connections.set(documentId, roomSockets); }
  if (roomSockets.size >= 50) { socket.close(1013, 'Document connection limit reached'); return; }
  roomSockets.set(socket, { userId: user.id, editable: permission === 'edit' });
  const controlled = new Set<number>();
  room.conns.set(socket, controlled);
  socket.binaryType = 'arraybuffer';

  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, SYNC);
  syncProtocol.writeSyncStep1(step1, room);
  send(socket, encoding.toUint8Array(step1));
  const awarenessIds = Array.from(room.awareness.getStates().keys());
  if (awarenessIds.length) {
    const awareness = encoding.createEncoder();
    encoding.writeVarUint(awareness, AWARENESS);
    encoding.writeVarUint8Array(awareness, awarenessProtocol.encodeAwarenessUpdate(room.awareness, awarenessIds));
    send(socket, encoding.toUint8Array(awareness));
  }

  socket.on('message', (raw) => {
    void (async () => {
      try {
        const bytes = new Uint8Array(raw as ArrayBuffer);
        const decoder = decoding.createDecoder(bytes);
        const messageType = decoding.readVarUint(decoder);
        if (messageType === SYNC) {
          const inspected = decoding.createDecoder(bytes);
          decoding.readVarUint(inspected);
          const syncType = decoding.readVarUint(inspected);
          if (syncType === 0) {
            const reply = encoding.createEncoder();
            encoding.writeVarUint(reply, SYNC);
            syncProtocol.readSyncMessage(decoder, reply, room, socket);
            if (encoding.length(reply) > 1) send(socket, encoding.toUint8Array(reply));
            return;
          }
          if (syncType === 1 || syncType === 2) {
            if (permission !== 'edit') {
              if (syncType === 2) socket.close(1008, 'Read-only access');
              return; // A read-only sync reply may contain stale IndexedDB state; never merge it.
            }
            const update = decoding.readVarUint8Array(inspected);
            await persistUpdate(room, update, socket);
            return;
          }
          socket.close(1003, 'Unsupported Yjs sync message');
          return;
        }
        if (messageType === AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), socket);
          return;
        }
        socket.close(1003, 'Unsupported Yjs message');
      } catch {
        socket.close(databaseHealthy ? 1003 : 1011, databaseHealthy ? 'Invalid Yjs message' : 'Synchronization failed; reconnect to retry');
      }
    })();
  });
  socket.on('close', () => {
    room.conns.delete(socket);
    roomSockets!.delete(socket);
    if (!roomSockets!.size) connections.delete(documentId);
    awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlled), null);
  });
}
