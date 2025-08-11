export const config = { runtime: 'edge' }

const rooms = globalThis.__WS_ROOMS__ || new Map()
const roomsMeta = globalThis.__WS_META__ || new Map()
if (!globalThis.__WS_ROOMS__) globalThis.__WS_ROOMS__ = rooms
if (!globalThis.__WS_META__) globalThis.__WS_META__ = roomsMeta

function getRoom(roomId) { if (!rooms.has(roomId)) rooms.set(roomId, new Map()); return rooms.get(roomId) }
function getRoomMeta(roomId) { if (!roomsMeta.has(roomId)) roomsMeta.set(roomId, new Map()); return roomsMeta.get(roomId) }
function broadcast(roomId, data, { exclude } = {}) { const room = rooms.get(roomId); if (!room) return; const payload = JSON.stringify(data); for (const [cid, sock] of room.entries()) { if (exclude && cid === exclude) continue; try { sock.send(payload) } catch {} } }

export default function handler(req) {
  if (req.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 400 })
  const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1]
  let clientId = crypto.randomUUID(); let roomId = null; let displayName = null; let isHost = false
  server.accept()
  server.addEventListener('message', (event) => {
    try {
      const { type, payload } = JSON.parse(event.data)
      if (type === 'JOIN') {
        roomId = payload.roomId; displayName = payload.displayName || 'Guest'; isHost = !!payload.isHost
        const room = getRoom(roomId); const meta = getRoomMeta(roomId); room.set(clientId, server); meta.set(clientId, { displayName, isHost })
        const peers = Array.from(meta.entries()).filter(([id]) => id !== clientId).map(([id, info]) => ({ id, displayName: info.displayName, isHost: info.isHost }))
        try { server.send(JSON.stringify({ type: 'PEERS', payload: { clientId, peers } })) } catch {}
        broadcast(roomId, { type: 'PEER_JOINED', payload: { clientId, displayName, isHost } }, { exclude: clientId }); return
      }
      if (!roomId) return
      if (type === 'SIGNAL') { const { targetId, data } = payload; const room = getRoom(roomId); const target = room.get(targetId); if (target) { try { target.send(JSON.stringify({ type: 'SIGNAL', payload: { fromId: clientId, data } })) } catch {} } return }
      if (type === 'HOST_EVENT' && isHost) { broadcast(roomId, { type: 'HOST_EVENT', payload: { fromId: clientId, event: payload.event, data: payload.data } }); return }
    } catch (e) { console.error('Edge WS bad message', e) }
  })
  function cleanup() { if (!roomId) return; const room = getRoom(roomId); const meta = getRoomMeta(roomId); room.delete(clientId); meta.delete(clientId); broadcast(roomId, { type: 'PEER_LEFT', payload: { clientId } }); if (room.size === 0) { rooms.delete(roomId); roomsMeta.delete(roomId) } }
  server.addEventListener('close', cleanup); server.addEventListener('error', cleanup)
  return new Response(null, { status: 101, webSocket: client })
}
