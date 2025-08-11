import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 3001;
const server = createServer();
const wss = new WebSocketServer({ server });

const rooms = new Map();
const roomsMeta = new Map(); // roomId -> Map(clientId -> { displayName, isHost })

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function getRoomMeta(roomId) {
  if (!roomsMeta.has(roomId)) roomsMeta.set(roomId, new Map());
  return roomsMeta.get(roomId);
}

function broadcast(roomId, data, { exclude } = {}) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [cid, sock] of room.entries()) {
    if (exclude && cid === exclude) continue;
    if (sock.readyState === 1) sock.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws) => {
  let clientId = randomUUID();
  let roomId = null;
  let displayName = null;
  let isHost = false;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type, payload } = msg;

      if (type === 'JOIN') {
        roomId = payload.roomId;
        displayName = payload.displayName || 'Guest';
        isHost = !!payload.isHost;
        const room = getRoom(roomId);
        const meta = getRoomMeta(roomId);
        room.set(clientId, ws);
        meta.set(clientId, { displayName, isHost });

        const peers = Array.from(meta.entries())
          .filter(([id]) => id !== clientId)
          .map(([id, info]) => ({ id, displayName: info.displayName, isHost: info.isHost }));

        ws.send(JSON.stringify({ type: 'PEERS', payload: { clientId, peers } }));

        broadcast(
          roomId,
          { type: 'PEER_JOINED', payload: { clientId, displayName, isHost } },
          { exclude: clientId }
        );
        return;
      }

      if (!roomId) return;

      if (type === 'SIGNAL') {
        const { targetId, data } = payload;
        const room = getRoom(roomId);
        const target = room.get(targetId);
        if (target && target.readyState === 1) {
          target.send(
            JSON.stringify({ type: 'SIGNAL', payload: { fromId: clientId, data } })
          );
        }
        return;
      }

      if (type === 'HOST_EVENT' && isHost) {
        broadcast(roomId, {
          type: 'HOST_EVENT',
          payload: { fromId: clientId, event: payload.event, data: payload.data },
        });
        return;
      }
    } catch (e) {
      console.error('Bad message', e);
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = getRoom(roomId);
    const meta = getRoomMeta(roomId);
    room.delete(clientId);
    meta.delete(clientId);
    broadcast(roomId, { type: 'PEER_LEFT', payload: { clientId } });
    if (room.size === 0) {
      rooms.delete(roomId);
      roomsMeta.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log('Signaling server listening on port', PORT);
});