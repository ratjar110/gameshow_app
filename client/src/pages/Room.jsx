import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

const WS_CANDIDATES = (() => {
  if (import.meta.env.VITE_SIGNAL_URL) return [import.meta.env.VITE_SIGNAL_URL]
  const sameOrigin = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`
  return import.meta.env.DEV ? ['ws://localhost:3001', 'ws://127.0.0.1:3001', sameOrigin] : [sameOrigin]
})()

export default function Room() {
  const { roomId } = useParams()
  const [me, setMe] = useState(null)
  const [wsOpen, setWsOpen] = useState(false)
  const wsRef = useRef(null)
  const pcRef = useRef(new Map())
  const localStreamRef = useRef(null)
  const gridRef = useRef(null)
  const peersMetaRef = useRef(new Map())
  const scoresRef = useRef({})
  const [scoresState, setScoresState] = useState({})
  const [announcement, setAnnouncement] = useState('')
  const groupsRef = useRef({})
  const myGroupRef = useRef(null)
  const [spotlight, setSpotlight] = useState(null)
  const [roundEndsAt, setRoundEndsAt] = useState(null)
  const revealedRef = useRef(false)
  const pendingCandidatesRef = useRef(new Map())
  const remoteStreamsRef = useRef(new Map()) // id -> MediaStream (for remote peers)
  const cameraHiddenRef = useRef(false)
  const screenTrackRef = useRef(null)

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
    toApply.forEach(async (c) => { try { await pc.addIceCandidate(new RTCIceCandidate(c)) } catch (e) { console.warn('ICE add error (flush)', e) } })
  }

  function createPC(remoteId) {
    const existing = pcRef.current.get(remoteId)
    if (existing) return existing
    const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] })
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'SIGNAL', payload: { targetId: remoteId, data: { kind: 'candidate', candidate: e.candidate } } }))
      }
    }
    pc.ontrack = (e) => {
      // Store remote stream; only render if revealed
      const [stream] = e.streams
      remoteStreamsRef.current.set(remoteId, stream)
      if (revealedRef.current) {
        ensureVideoEl(remoteId, stream)
      } else {
        // If a video element was created earlier, remove it (shouldn't happen, but for safety)
        const el = document.getElementById(`vid-${remoteId}`)
        if (el && remoteId !== 'me') el.parentElement?.remove()
      }
    }
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') disconnectPeer(remoteId) }
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
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'SIGNAL', payload: { targetId: remoteId, data: { kind: 'offer', sdp: offer } } }))
  }

  async function handleSignal(fromId, data) {
    try {
      let pc = pcRef.current.get(fromId)
      if (!pc && data.kind === 'offer') pc = createPC(fromId)
      if (!pc) return
      if (data.kind === 'offer') {
        if (pc.signalingState === 'have-local-offer') { try { await pc.setLocalDescription({ type: 'rollback' }) } catch {} }
        if (pc.signalingState === 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
          flushPendingCandidates(fromId)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
            if (wsRef.current?.readyState === 1) {
              wsRef.current.send(JSON.stringify({ type: 'SIGNAL', payload: { targetId: fromId, data: { kind: 'answer', sdp: answer } } }))
            }
        } else {
          console.warn('Offer ignored due to PC state:', pc.signalingState)
        }
      } else if (data.kind === 'answer') {
        if (pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); flushPendingCandidates(fromId) }
      } else if (data.kind === 'candidate') {
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)) } catch (e) { console.warn('ICE add error', e) }
        } else {
          const q = pendingCandidatesRef.current.get(fromId) || []
          q.push(data.candidate)
          pendingCandidatesRef.current.set(fromId, q)
        }
      }
    } catch (e) { console.error('handleSignal error', e) }
  }

  function disconnectPeer(id) {
    const pc = pcRef.current.get(id)
    if (pc) { try { pc.close() } catch {} pcRef.current.delete(id) }
    const el = document.getElementById(`vid-${id}`)
    if (el) el.parentElement?.remove()
  }

  useEffect(() => {
    let cancelled = false
    let candidateIndex = 0
    let reconnectTimer = null

    async function init() {
      try { await getLocalMedia() } catch (e) { console.error('media error', e); return }
      attempt()
    }

    function scheduleReconnect(delay = 800) {
      if (cancelled) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => attempt(true), delay)
    }

    function attempt(isRetry=false) {
      if (cancelled) return
      const url = WS_CANDIDATES[candidateIndex]
      console.log('[room] ws attempt', url, 'retry?', isRetry)
      let ws
      try { ws = new WebSocket(url) } catch (e) { console.warn('create ws error', e); nextCandidate(); return }
      wsRef.current = ws
      let opened = false
      const openTimeout = setTimeout(() => { if (!opened) { try { ws.close() } catch {} } }, 1200)
      ws.onopen = () => {
        if (cancelled) return
        opened = true
        clearTimeout(openTimeout)
        setWsOpen(true)
        ws.send(JSON.stringify({ type: 'JOIN', payload: { roomId, displayName: 'Audience', isHost: false } }))
      }
      ws.onclose = () => { setWsOpen(false); if (!cancelled) nextCandidate(true) }
      ws.onerror = () => { try { ws.close() } catch {} }
      ws.onmessage = async (msg) => {
        if (cancelled) return
        try {
          const { type, payload } = JSON.parse(msg.data)
          if (type === 'PEERS') {
            setMe(payload.clientId)
            peersMetaRef.current = new Map(payload.peers.map(p => [p.id, { isHost: !!p.isHost, displayName: p.displayName, group: p.group || null }]))
            // Derive my group if present in list (should not for self, but future-proof if host supplies)
            const selfEntry = payload.peers.find(p => p.id === payload.clientId)
            if (selfEntry && selfEntry.group) myGroupRef.current = selfEntry.group
            // If already revealed (unlikely on first join) we might initiate calls
            if (revealedRef.current) {
              for (const [id, meta] of peersMetaRef.current.entries()) {
                if (!meta.isHost && id !== me && me && me < id) await callPeer(id)
              }
            }
          }
          if (type === 'PEER_JOINED') {
            peersMetaRef.current.set(payload.clientId, { isHost: !!payload.isHost, displayName: payload.displayName })
            if (revealedRef.current && !payload.isHost && me && me < payload.clientId) await callPeer(payload.clientId)
          }
          if (type === 'SIGNAL') { const { fromId, data } = payload; await handleSignal(fromId, data) }
          if (type === 'PEER_LEFT') { const { clientId } = payload; peersMetaRef.current.delete(clientId); disconnectPeer(clientId) }
          if (type === 'HOST_EVENT') {
            const { event, data } = payload
            if (event === 'REVEAL_CONTESTANTS') {
              revealedRef.current = true
              // Establish peer connections to non-host peers (mesh) while preserving existing host connection
              for (const [id, info] of peersMetaRef.current.entries()) {
                if (!info.isHost && id !== me && me && me < id) await callPeer(id)
              }
              // Render all stored remote streams now
              for (const [id, stream] of remoteStreamsRef.current.entries()) {
                if (id !== me) {
                  const meta = peersMetaRef.current.get(id)
                  if (!data?.groups || !myGroupRef.current || (meta?.group && meta.group === myGroupRef.current)) {
                    ensureVideoEl(id, stream)
                  }
                }
              }
            }
            if (event === 'HIDE_CONTESTANTS') {
              revealedRef.current = false
              // Remove remote video elements but keep underlying peer connections so host still sees everyone
              for (const [id, info] of peersMetaRef.current.entries()) {
                if (id !== me) {
                  const el = document.getElementById(`vid-${id}`)
                  if (el) el.parentElement?.remove()
                }
              }
            }
            if (event === 'SCORES_UPDATE') { scoresRef.current = data?.scores || {}; setScoresState(scoresRef.current) }
            if (event === 'ANNOUNCEMENT') { setAnnouncement(data?.text || '') }
            if (event === 'SPOTLIGHT') { setSpotlight(data?.targetId); document.querySelectorAll('.video-wrapper').forEach(el=> el.classList.remove('spotlight')); const el = document.getElementById(`vid-${data?.targetId}`)?.parentElement; if (el) el.classList.add('spotlight') }
            if (event === 'CLEAR_SPOTLIGHT') { setSpotlight(null); document.querySelectorAll('.video-wrapper').forEach(el=> el.classList.remove('spotlight')) }
            if (event === 'GROUPS_UPDATE') {
              groupsRef.current = data?.groups || {}
              // Determine my group from mapping (if assigned afterward)
              if (groupsRef.current[me]) myGroupRef.current = groupsRef.current[me]
              // Filter displayed peers if grouping active
              if (revealedRef.current && myGroupRef.current) {
                document.querySelectorAll('.video-wrapper').forEach(el => {
                  const vid = el.querySelector('video')
                  if (!vid) return
                  const id = vid.id.replace('vid-','')
                  if (id === 'me') return
                  const meta = peersMetaRef.current.get(id)
                  if (meta && meta.group && meta.group !== myGroupRef.current) {
                    el.style.display = 'none'
                  } else {
                    el.style.display = ''
                  }
                })
              } else if (revealedRef.current) {
                // If no grouping for me, show all
                document.querySelectorAll('.video-wrapper').forEach(el => { el.style.display = '' })
              }
            }
            if (event === 'MUTE' && data?.targetId === me) { localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = false) }
            if (event === 'UNMUTE' && data?.targetId === me) { localStreamRef.current?.getAudioTracks().forEach(t => t.enabled = true) }
            if (event === 'START_ROUND') { setRoundEndsAt(data?.endsAt || (Date.now() + (data?.duration||60)*1000)) }
            if (event === 'END_ROUND') { setRoundEndsAt(null) }
            if (event === 'HIDE_CAM' && data?.targetId === me) {
              cameraHiddenRef.current = true
              // Disable video tracks locally (stop sending) and hide element
              localStreamRef.current?.getVideoTracks().forEach(t => t.enabled = false)
              const el = document.getElementById('vid-me') || document.getElementById('vid-host')
              if (el) el.style.filter = 'grayscale(1) brightness(0.3)'
            }
            if (event === 'SHOW_CAM' && data?.targetId === me) {
              cameraHiddenRef.current = false
              localStreamRef.current?.getVideoTracks().forEach(t => t.enabled = true)
              const el = document.getElementById('vid-me') || document.getElementById('vid-host')
              if (el) el.style.filter = ''
            }
            if (event === 'REQUEST_SCREEN_SHARE' && data?.targetId === me) {
              try {
                if (!screenTrackRef.current) {
                  const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true })
                  const track = screenStream.getVideoTracks()[0]
                  screenTrackRef.current = track
                  // Add to all peer connections
                  pcRef.current.forEach(pc => pc.addTrack(track, screenStream))
                  track.onended = () => {
                    screenTrackRef.current = null
                    pcRef.current.forEach(pc => {
                      const senders = pc.getSenders().filter(s => s.track === track)
                      senders.forEach(s => pc.removeTrack(s))
                    })
                    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type:'HOST_EVENT', payload:{ event:'STOP_SCREEN_SHARE', data:{ targetId: me } } }))
                  }
                }
              } catch (err) { console.warn('Screen share denied', err) }
            }
            if (event === 'STOP_SCREEN_SHARE' && data?.targetId === me) {
              const track = screenTrackRef.current
              if (track) {
                pcRef.current.forEach(pc => {
                  const senders = pc.getSenders().filter(s => s.track === track)
                  senders.forEach(s => pc.removeTrack(s))
                })
                track.stop()
                screenTrackRef.current = null
              }
            }
          }
        } catch (err) { console.error('WS message error', err) }
      }
    }

    function nextCandidate(triggerReconnect=false) {
      if (cancelled) return
      if (candidateIndex < WS_CANDIDATES.length - 1) {
        candidateIndex++
        setTimeout(() => attempt(), 200)
      } else if (triggerReconnect) {
        scheduleReconnect(Math.min(5000, 800 + candidateIndex * 400))
      }
    }

    init()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
      pcRef.current.forEach(pc => { try { pc.close() } catch {} })
      pcRef.current.clear()
    }
  }, [roomId])

  return (
    <div className="page">
      <h2>Room: {roomId}</h2>
      <div>Status: {wsOpen ? 'Connected' : 'Connecting...'}</div>
      {announcement && <div className="announcement-banner">{announcement}</div>}
  {roundEndsAt && <div style={{position:'fixed', left:24, top:24, background:'#161b22', padding:'6px 12px', border:'1px solid #30363d', borderRadius:8, fontSize:14}}>Time left: {Math.max(0, Math.ceil((roundEndsAt - Date.now())/1000))}s</div>}
      <div ref={gridRef} className="videos-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginTop: '1rem' }} />
      {Object.keys(scoresState).length > 0 && (
        <div className="scoreboard-overlay">
          {Object.entries(scoresState).map(([id, score]) => (
            <div key={id}>{peersMetaRef.current.get(id)?.displayName || id}: {score}</div>
          ))}
        </div>
      )}
    </div>
  )
}
