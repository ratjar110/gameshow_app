import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

const WS_URL = import.meta.env.VITE_SIGNAL_URL || (
  import.meta.env.DEV
    ? 'ws://localhost:3001'
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`
)

export default function Room() {
  const { roomId } = useParams()
  const [me, setMe] = useState(null)
  const [wsOpen, setWsOpen] = useState(false)
  const wsRef = useRef(null)
  const pcRef = useRef(new Map())
  const localStreamRef = useRef(null)
  const gridRef = useRef(null)
  const peersMetaRef = useRef(new Map()) // id -> { isHost, displayName }
  const scoresRef = useRef({})
  const [scoresState, setScoresState] = useState({})
  const [announcement, setAnnouncement] = useState('')
  const [spotlight, setSpotlight] = useState(null)
  const revealedRef = useRef(false)
  const pendingCandidatesRef = useRef(new Map()) // id -> RTCIceCandidateInit[]

  function ensureVideoEl(id, stream, isSelf=false) {
    const existing = document.getElementById(`vid-${id}`)
    if (existing) {
      if (existing.srcObject !== stream) existing.srcObject = stream
      if (spotlight === id) existing.parentElement?.classList.add('spotlight')
      return existing
    }
    const wrap = document.createElement('div')
    wrap.className = 'video-wrapper'
    if (spotlight === id) wrap.classList.add('spotlight')
    const v = document.createElement('video')
    v.id = `vid-${id}`
    v.autoplay = true
    v.playsInline = true
    v.muted = isSelf
    v.srcObject = stream
    const badge = document.createElement('div')
    badge.className = 'badge'
    badge.textContent = isSelf ? 'You' : (peersMetaRef.current.get(id)?.displayName || 'Peer')
    wrap.appendChild(v)
    wrap.appendChild(badge)
    gridRef.current?.appendChild(wrap)
    return v
  }

  async function getLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    localStreamRef.current = stream
    ensureVideoEl('me', stream, true)
    return stream
  }

  function flushPendingCandidates(remoteId) {
    const queue = pendingCandidatesRef.current.get(remoteId)
    if (!queue || queue.length === 0) return
    const pc = pcRef.current.get(remoteId)
    if (!pc || !pc.remoteDescription) return
    const toApply = [...queue]
    pendingCandidatesRef.current.set(remoteId, [])
    toApply.forEach(async (c) => {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)) } catch (e) { console.warn('ICE add error (flush)', e) }
    })
  }

  function createPC(remoteId) {
    const existing = pcRef.current.get(remoteId)
    if (existing) return existing
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
    })

    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'SIGNAL',
          payload: { targetId: remoteId, data: { kind: 'candidate', candidate: e.candidate } }
        }))
      }
    }

    pc.ontrack = (e) => {
      const [stream] = e.streams
      ensureVideoEl(remoteId, stream)
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        disconnectPeer(remoteId)
      }
    }

    const stream = localStreamRef.current
    stream.getTracks().forEach(t => pc.addTrack(t, stream))

    pcRef.current.set(remoteId, pc)
    return pc
  }

  async function callPeer(remoteId) {
    if (pcRef.current.has(remoteId)) return
    const pc = createPC(remoteId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: 'SIGNAL',
        payload: { targetId: remoteId, data: { kind: 'offer', sdp: offer } }
      }))
    }
  }

  async function handleSignal(fromId, data) {
    try {
      let pc = pcRef.current.get(fromId)
      if (!pc && data.kind === 'offer') {
        pc = createPC(fromId)
      }
      if (!pc) return

      if (data.kind === 'offer') {
        // Handle glare: if we already have a local offer, roll back
        if (pc.signalingState === 'have-local-offer') {
          try { await pc.setLocalDescription({ type: 'rollback' }) } catch {}
        }
        if (pc.signalingState === 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
          flushPendingCandidates(fromId)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({
              type: 'SIGNAL',
              payload: { targetId: fromId, data: { kind: 'answer', sdp: answer } }
            }))
          } else {
            console.warn('WS not open to send answer; dropping')
          }
        } else {
          console.warn('Offer ignored due to PC state:', pc.signalingState)
        }
      } else if (data.kind === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
          flushPendingCandidates(fromId)
        } else {
          console.warn('Cannot handle answer, PC state:', pc.signalingState)
        }
      } else if (data.kind === 'candidate') {
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)) } catch (e) { console.warn('ICE add error', e) }
        } else {
          const q = pendingCandidatesRef.current.get(fromId) || []
          q.push(data.candidate)
          pendingCandidatesRef.current.set(fromId, q)
        }
      }
    } catch (e) {
      console.error('handleSignal error', e)
    }
  }

  function disconnectPeer(id) {
    const pc = pcRef.current.get(id)
    if (pc) {
      try { pc.close() } catch {}
      pcRef.current.delete(id)
    }
    const el = document.getElementById(`vid-${id}`)
    if (el) el.remove()
  }

  useEffect(() => {
    let closed = false

    ;(async () => {
      const stream = await getLocalMedia()

      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setWsOpen(true)
        ws.send(JSON.stringify({ type: 'JOIN', payload: { roomId, displayName: 'Audience', isHost: false } }))
      }

      ws.onmessage = async (msg) => {
        try {
          const { type, payload } = JSON.parse(msg.data)

          if (type === 'PEERS') {
            setMe(payload.clientId)
            // save roles
            peersMetaRef.current = new Map(payload.peers.map(p => [p.id, { isHost: !!p.isHost, displayName: p.displayName }]))
            // Do NOT proactively call host; wait for host to offer
          }
          if (type === 'PEER_JOINED') {
            peersMetaRef.current.set(payload.clientId, { isHost: !!payload.isHost, displayName: payload.displayName })
            // do not call host
            if (revealedRef.current && !payload.isHost && me && me < payload.clientId) {
              await callPeer(payload.clientId)
            }
          }
          if (type === 'SIGNAL') {
            const { fromId, data } = payload
            await handleSignal(fromId, data)
          }
          if (type === 'PEER_LEFT') {
            const { clientId } = payload
            peersMetaRef.current.delete(clientId)
            disconnectPeer(clientId)
          }
          if (type === 'HOST_EVENT') {
            const { event } = payload
            if (event === 'REVEAL_CONTESTANTS') {
              revealedRef.current = true
              // connect to all non-host peers with id greater than mine to avoid glare
              for (const [id, info] of peersMetaRef.current.entries()) {
                if (!info.isHost && id !== me && me && me < id) {
                  await callPeer(id)
                }
              }
            }
            if (event === 'HIDE_CONTESTANTS') {
              revealedRef.current = false
              // disconnect from all non-host peers (keep host)
              for (const [id, info] of peersMetaRef.current.entries()) {
                if (!info.isHost && id !== me) {
                  disconnectPeer(id)
                }
              }
            }
            if (event === 'SCORES_UPDATE') {
              scoresRef.current = payload.payload.data?.scores || {}
              setScoresState(scoresRef.current)
            }
            if (event === 'ANNOUNCEMENT') {
              setAnnouncement(payload.payload.data?.text || '')
            }
            if (event === 'SPOTLIGHT') {
              setSpotlight(payload.payload.data?.targetId)
              document.querySelectorAll('.video-wrapper').forEach(el=> el.classList.remove('spotlight'))
              const el = document.getElementById(`vid-${payload.payload.data?.targetId}`)?.parentElement
              if (el) el.classList.add('spotlight')
            }
            if (event === 'CLEAR_SPOTLIGHT') {
              setSpotlight(null)
              document.querySelectorAll('.video-wrapper').forEach(el=> el.classList.remove('spotlight'))
            }
            if (event === 'MUTE' && payload.payload.data?.targetId === me) {
              localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = false)
            }
            if (event === 'UNMUTE' && payload.payload.data?.targetId === me) {
              localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = true)
            }
          }
        } catch (err) {
          console.error('WS message handling error', err)
        }
      }

      ws.onclose = () => setWsOpen(false)

      return () => {
        if (closed) return
        ws.close()
        stream.getTracks().forEach(t => t.stop())
        for (const pc of pcRef.current.values()) pc.close()
        pcRef.current.clear()
        peersMetaRef.current.clear()
        revealedRef.current = false
        pendingCandidatesRef.current.clear()
        closed = true
      }
    })()
  // Only depend on roomId; do not re-create on me changes to avoid race conditions
  }, [roomId])

  return (
    <div className="layout">
      <div className="container">
        <h2 style={{marginTop:0}}>Room {roomId}</h2>
        <div style={{opacity:.6, fontSize:14, marginBottom:12}}>{wsOpen ? 'Connected' : 'Connecting...'}</div>
        <div ref={gridRef} className="grid-videos" />
      </div>
      {announcement && <div className="announcement-banner">{announcement}</div>}
      {Object.keys(scoresState).length>0 && (
        <div className="scoreboard-overlay panel">
          <h4>Scores</h4>
          {Object.entries(scoresState).sort((a,b)=> (b[1]??0)-(a[1]??0)).map(([id, sc]) => {
            const meta = peersMetaRef.current.get(id) || {}
            return <div key={id} style={{display:'flex', justifyContent:'space-between', fontSize:12, padding:'2px 0'}}><span style={{maxWidth:130, overflow:'hidden', textOverflow:'ellipsis'}} title={meta.displayName||id}>{meta.displayName||id.slice(0,6)}</span><strong>{sc}</strong></div>
          })}
        </div>
      )}
    </div>
  )
}
