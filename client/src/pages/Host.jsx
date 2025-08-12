import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

// Resolve WebSocket URL(s) with dev fallback list
const WS_CANDIDATES = (() => {
  if (import.meta.env.VITE_SIGNAL_URL) return [import.meta.env.VITE_SIGNAL_URL]
  const sameOrigin = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`
  if (import.meta.env.DEV) {
    // Prefer dedicated local signaling first for faster dev feedback
    return ['ws://localhost:3001', 'ws://127.0.0.1:3001', sameOrigin]
  }
  return [sameOrigin]
})()

export default function Host() {
  const { roomId } = useParams()
  const [me, setMe] = useState(null)
  const [wsOpen, setWsOpen] = useState(false)
  const [participants, setParticipants] = useState(new Map()) // id -> { isHost, displayName }
  const [scores, setScores] = useState({})
  const [announcement, setAnnouncement] = useState('')
  const [spotlight, setSpotlight] = useState(null)
  const [roundDuration, setRoundDuration] = useState(60) // seconds
  const [roundEndsAt, setRoundEndsAt] = useState(null) // timestamp ms
  const annInputRef = useRef(null)
  const wsRef = useRef(null)
  const pcRef = useRef(new Map())
  const localStreamRef = useRef(null)
  const gridRef = useRef(null)
  const dragStateRef = useRef({ order: [], positions: new Map(), dragging: null, offset:{x:0,y:0}, pointerStart:{x:0,y:0}, layoutDirty:false, framePending:false, cols:1, tile:{w:220,h:220/(16/9),gap:16} })
  const pendingCalls = useRef(new Set()) // Track pending calls to prevent duplicates
  const [selectedParticipant, setSelectedParticipant] = useState(null)
  const [participantStates, setParticipantStates] = useState(new Map()) // id -> { muted, camHidden, sharing }
  const [groups, setGroups] = useState({}) // id -> groupName
  const [newGroupName, setNewGroupName] = useState('')

  function ensureVideoEl(id, stream, isSelf=false) {
    const tileId = `tile-${id}`
    let tile = document.getElementById(tileId)
    if (tile) {
      const v = tile.querySelector('video')
      if (v && v.srcObject !== stream) v.srcObject = stream
      return v
    }
    tile = document.createElement('div')
    tile.className = 'video-tile'
    tile.id = tileId
    tile.setAttribute('data-id', id)
    const v = document.createElement('video')
    v.autoplay = true
    v.playsInline = true
    v.muted = isSelf
    v.srcObject = stream
    const badge = document.createElement('div')
    badge.className = 'badge'
    badge.textContent = isSelf ? 'Host' : (participants.get(id)?.displayName || id.slice(0,6))
    tile.appendChild(v)
    tile.appendChild(badge)
    gridRef.current?.appendChild(tile)
    addTileToLayout(id, tile)
    return v
  }

  function addTileToLayout(id, tile) {
    const ds = dragStateRef.current
    if (!ds.order.includes(id)) ds.order.push(id)
    layoutTiles()
    tile.addEventListener('pointerdown', onPointerDown)
  }

  function layoutTiles() {
    const ds = dragStateRef.current
    const container = gridRef.current
    if (!container) return
    const width = container.clientWidth
    const { w: tileW, h: tileH, gap } = ds.tile
    const cols = Math.max(1, Math.floor((width + gap) / (tileW + gap)))
    ds.cols = cols
    ds.order.forEach((id, index) => {
      if (ds.dragging === id) return
      const tile = document.getElementById(`tile-${id}`)
      if (!tile) return
      const col = index % cols
      const row = Math.floor(index / cols)
      const x = col * (tileW + gap)
      const y = row * (tileH + gap)
      tile.style.transform = `translate(${x}px, ${y}px)`
      ds.positions.set(id, { x, y, w: tileW, h: tileH })
    })
    const rows = Math.ceil(ds.order.length / cols)
    container.style.height = rows * (tileH + gap) - gap + 'px'
  }

  function onPointerDown(e) {
    const tile = e.currentTarget
    const id = tile.getAttribute('data-id')
    const ds = dragStateRef.current
    ds.dragging = id
    tile.classList.add('dragging')
    const rect = tile.getBoundingClientRect()
    ds.offset = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    ds.pointerStart = { x: e.clientX, y: e.clientY }
    tile.setPointerCapture(e.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  function onPointerMove(e) {
    const ds = dragStateRef.current
    if (!ds.dragging) return
    if (ds.framePending) return
    ds.framePending = true
    requestAnimationFrame(() => {
      ds.framePending = false
      const tile = document.getElementById(`tile-${ds.dragging}`)
      if (!tile) return
      const containerRect = gridRef.current.getBoundingClientRect()
      const x = e.clientX - containerRect.left - ds.offset.x
      const y = e.clientY - containerRect.top - ds.offset.y
      tile.style.transform = `translate(${x}px, ${y}px)`
      maybeReorderLinear(ds.dragging, x, y)
    })
  }

  function maybeReorderLinear(id, x, y) {
    const ds = dragStateRef.current
    const { w: tileW, h: tileH, gap } = ds.tile
    const cols = ds.cols || 1
    // Compute intended grid cell from center point
    const centerX = x + tileW/2
    const centerY = y + tileH/2
    let col = Math.round(centerX / (tileW + gap) - 0.5)
    let row = Math.round(centerY / (tileH + gap) - 0.5)
    col = Math.max(0, Math.min(cols - 1, col))
    row = Math.max(0, Math.min( Math.ceil(dragStateRef.current.order.length / cols), row))
    let newIndex = row * cols + col
    if (newIndex >= ds.order.length) newIndex = ds.order.length - 1
    const currentIndex = ds.order.indexOf(id)
    if (newIndex !== currentIndex && newIndex >= 0) {
      ds.order.splice(currentIndex, 1)
      ds.order.splice(newIndex, 0, id)
      layoutTiles()
    }
  }

  function onPointerUp(e) {
    const ds = dragStateRef.current
    const id = ds.dragging
    ds.dragging = null
    const tile = id && document.getElementById(`tile-${id}`)
    if (tile) tile.classList.remove('dragging')
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    layoutTiles()
    // Treat as click/select if minimal movement
    if (id) {
      const dx = Math.abs(e.clientX - ds.pointerStart.x)
      const dy = Math.abs(e.clientY - ds.pointerStart.y)
      if (dx < 5 && dy < 5) {
        setSelectedParticipant(prev => prev === id ? null : id)
      }
    }
  }

  useEffect(() => {
    const handleResize = () => layoutTiles()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  async function getLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    localStreamRef.current = stream
    ensureVideoEl('host', stream, true)
    return stream
  }

  function createPC(remoteId) {
    // Check if PC already exists
    if (pcRef.current.has(remoteId)) {
      console.log('Reusing existing peer connection for', remoteId)
      return pcRef.current.get(remoteId)
    }

    console.log('Creating new peer connection for', remoteId)
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
      console.log('Received track from', remoteId)
      const [stream] = e.streams
  ensureVideoEl(remoteId, stream) // Host always displays all remote streams immediately
    }

    pc.onconnectionstatechange = () => {
      console.log('Connection state changed for', remoteId, ':', pc.connectionState)
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        // Clean up failed connections
        pcRef.current.delete(remoteId)
        const el = document.getElementById(`vid-${remoteId}`)
        el?.remove()
      }
    }
    
    // Only add tracks if we have local stream
    const stream = localStreamRef.current
    if (stream) {
      stream.getTracks().forEach(t => pc.addTrack(t, stream))
    } else {
      console.warn('No local stream available when creating PC for', remoteId)
    }
    
    pcRef.current.set(remoteId, pc)
    return pc
  }

  async function callPeer(remoteId) {
    // Prevent duplicate calls
    if (pendingCalls.current.has(remoteId) || pcRef.current.has(remoteId)) {
      console.log('Skipping call to', remoteId, '- already exists or pending')
      return
    }
    
    console.log('Calling peer', remoteId)
    pendingCalls.current.add(remoteId)
    
    try {
      const pc = createPC(remoteId)
      
      // Ensure we have local media before creating offer
      if (!localStreamRef.current) {
        await getLocalMedia()
      }
      
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({
          type: 'SIGNAL',
          payload: { targetId: remoteId, data: { kind: 'offer', sdp: offer } }
        }))
        console.log('Sent offer to', remoteId)
      } else {
        console.warn('Cannot send offer - WebSocket not connected')
      }
    } catch (error) {
      console.error('Error calling peer:', error)
      // Clean up on error
      const pc = pcRef.current.get(remoteId)
      if (pc) {
        pc.close()
        pcRef.current.delete(remoteId)
      }
    } finally {
      pendingCalls.current.delete(remoteId)
    }
  }

  async function handleSignal(fromId, data) {
    let pc = pcRef.current.get(fromId)
    if (!pc && data.kind === 'offer') {
      pc = createPC(fromId)
    }
    if (!pc) return

    try {
      if (data.kind === 'offer') {
        // Check if we can set remote description
        if (pc.signalingState === 'stable' || pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({
              type: 'SIGNAL',
              payload: { targetId: fromId, data: { kind: 'answer', sdp: answer } }
            }))
          }
        } else {
          console.warn('Cannot handle offer, PC state:', pc.signalingState)
        }
      } else if (data.kind === 'answer') {
        // Check if we're expecting an answer
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        } else {
          console.warn('Cannot handle answer, PC state:', pc.signalingState)
        }
      } else if (data.kind === 'candidate') {
        // Only add candidates if we have remote description
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
        } else {
          console.warn('Cannot add candidate, no remote description yet')
        }
      }
    } catch (error) {
      console.error('Error handling signal:', error)
      // If there's a critical error, recreate the peer connection
      if (error.name === 'InvalidStateError') {
        console.log('Recreating peer connection due to state error')
        const oldPc = pcRef.current.get(fromId)
        if (oldPc) {
          oldPc.close()
          pcRef.current.delete(fromId)
        }
        // Don't immediately recreate, let the next offer create it
      }
    }
  }

  function sendHostEvent(event, data = {}) {
    // Only send if WebSocket is open
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'HOST_EVENT', payload: { event, data } }))
    } else {
      console.warn('Cannot send host event: WebSocket not connected')
    }
  }

  function updateScore(id, value) {
    const v = parseInt(value, 10)
    if (Number.isNaN(v)) return
    const next = { ...scores, [id]: v }
    setScores(next)
    sendHostEvent('SCORES_UPDATE', { scores: next })
  }

  function toggleMute(id, shouldMute) {
    sendHostEvent(shouldMute ? 'MUTE' : 'UNMUTE', { targetId: id })
  }

  function setSpotlightTarget(id) {
    if (id === spotlight) {
      setSpotlight(null)
      sendHostEvent('CLEAR_SPOTLIGHT', {})
    } else {
      setSpotlight(id)
      sendHostEvent('SPOTLIGHT', { targetId: id })
    }
  }

  function broadcastAnnouncement() {
    const text = annInputRef.current?.value?.trim()
    if (!text) return
    setAnnouncement(text)
    sendHostEvent('ANNOUNCEMENT', { text })
    annInputRef.current.value = ''
  }

  function startRound() {
    if (!wsOpen) return
    const dur = Math.max(5, Math.min(3600, parseInt(roundDuration, 10) || 60))
    const endsAt = Date.now() + dur * 1000
    setRoundEndsAt(endsAt)
    sendHostEvent('START_ROUND', { duration: dur, endsAt })
  }

  function endRound() {
    if (!wsOpen) return
    setRoundEndsAt(null)
    sendHostEvent('END_ROUND', {})
  }

  // Host local countdown tick
  useEffect(() => {
    if (!roundEndsAt) return
    const t = setInterval(() => { if (Date.now() >= roundEndsAt) { endRound() } else { /* trigger re-render */ setRoundEndsAt(prev => prev ? prev : null) } }, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundEndsAt])

  useEffect(() => {
    let cancelled = false
    let candidateIndex = 0
    let reconnectTimer = null

    async function ensureMedia() {
      try { await getLocalMedia() } catch (e) { console.warn('Media permission failed; continuing without local stream', e) }
    }

    function attempt(isRetry=false) {
      if (cancelled) return
      const url = WS_CANDIDATES[candidateIndex]
      console.log('[host] ws attempt', url, 'retry?', isRetry)
      let ws
      try { ws = new WebSocket(url) } catch (e) { console.warn('host ws create error', e); nextCandidate(); return }
      wsRef.current = ws
      let opened = false
      // Fallback timeout: if not open within 1.2s rotate
      const openTimeout = setTimeout(() => { if (!opened) { try { ws.close() } catch {} } }, 1200)
      ws.onopen = () => {
        if (cancelled) return
        opened = true
        clearTimeout(openTimeout)
        setWsOpen(true)
        ws.send(JSON.stringify({ type: 'JOIN', payload: { roomId, displayName: 'Host', isHost: true } }))
        ensureMedia() // fetch media after socket open to reduce delay to join message
      }
      ws.onerror = () => { /* force rotation sooner if handshake fails */ try { ws.close() } catch {} }
      ws.onclose = () => { setWsOpen(false); if (!cancelled) nextCandidate(true) }
      ws.onmessage = async (msg) => {
        if (cancelled) return
        try {
          const { type, payload } = JSON.parse(msg.data)
          if (type === 'PEERS') {
            setMe(payload.clientId)
            const map = new Map()
            const g = {}
            for (const p of payload.peers) { map.set(p.id, { isHost: !!p.isHost, displayName: p.displayName }); if (p.group) g[p.id] = p.group }
            setGroups(g)
            setParticipants(map)
            // initiate calls to every peer
            for (const id of map.keys()) { if (!pcRef.current.has(id) && !pendingCalls.current.has(id)) await callPeer(id) }
          }
          if (type === 'PEER_JOINED') {
            if (payload.clientId !== me && !pcRef.current.has(payload.clientId)) await callPeer(payload.clientId)
            setParticipants(prev => new Map(prev).set(payload.clientId, { isHost: !!payload.isHost, displayName: payload.displayName }))
          }
            if (type === 'SIGNAL') { const { fromId, data } = payload; await handleSignal(fromId, data) }
          if (type === 'PEER_LEFT') {
            const { clientId } = payload
            const pc = pcRef.current.get(clientId)
            if (pc) { pc.close(); pcRef.current.delete(clientId) }
            pendingCalls.current.delete(clientId)
            const el = document.getElementById(`vid-${clientId}`); el?.remove()
            setParticipants(prev => { const next = new Map(prev); next.delete(clientId); return next })
          }
          if (type === 'HOST_EVENT') {
            const { event, data } = payload
            if (event === 'SCORES_UPDATE') setScores(data.scores || {})
            if (event === 'ANNOUNCEMENT') setAnnouncement(data.text || '')
            if (event === 'SPOTLIGHT') setSpotlight(data.targetId)
            if (event === 'CLEAR_SPOTLIGHT') setSpotlight(null)
            if (event === 'START_ROUND') setRoundEndsAt(data.endsAt || (Date.now() + (data.duration||60)*1000))
            if (event === 'END_ROUND') setRoundEndsAt(null)
            if (event === 'GROUPS_UPDATE' && data?.groups) setGroups(data.groups)
            if (['MUTE','UNMUTE','HIDE_CAM','SHOW_CAM','REQUEST_SCREEN_SHARE','STOP_SCREEN_SHARE'].includes(event)) {
              const pid = data?.targetId
              if (pid) setParticipantStates(prev => {
                const next = new Map(prev)
                const st = { muted:false, camHidden:false, sharing:false, ...(next.get(pid)||{}) }
                if (event === 'MUTE') st.muted = true
                if (event === 'UNMUTE') st.muted = false
                if (event === 'HIDE_CAM') st.camHidden = true
                if (event === 'SHOW_CAM') st.camHidden = false
                if (event === 'REQUEST_SCREEN_SHARE') st.sharing = true
                if (event === 'STOP_SCREEN_SHARE') st.sharing = false
                next.set(pid, st)
                return next
              })
            }
          }
        } catch (err) { console.error('host ws message error', err) }
      }
    }

    function scheduleReconnect(delay = 800) {
      if (cancelled) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => attempt(true), delay)
    }

    function nextCandidate(triggerReconnect=false) {
      if (cancelled) return
      if (candidateIndex < WS_CANDIDATES.length - 1) {
        candidateIndex++
        setTimeout(() => attempt(), 200)
      } else if (triggerReconnect) {
        // Backoff with cap
        const delay = Math.min(5000, 800 + candidateIndex * 400)
        scheduleReconnect(delay)
      }
    }

    attempt()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
      if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null }
      for (const pc of pcRef.current.values()) { try { pc.close() } catch {} }
      pcRef.current.clear()
      pendingCalls.current.clear()
      setWsOpen(false)
      setMe(null)
    }
  }, [roomId])

  function assignGroup(id, groupName) {
    setGroups(prev => {
      const next = { ...prev, [id]: groupName || undefined }
      return next
    })
  }

  function broadcastGroups() {
    sendHostEvent('GROUPS_UPDATE', { groups })
  }

  // Small reusable icon toggle button for compact participant bar
  function IconToggle({ title, active, onClick, activeIcon, inactiveIcon }) {
    return (
      <button
        onClick={onClick}
        title={title}
        className={active ? 'icon-toggle active' : 'icon-toggle'}
        style={{
          background: active ? 'var(--color-accent)' : 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 8,
          width: 40,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          cursor: 'pointer'
        }}
      >
        <span aria-hidden>{active ? activeIcon : inactiveIcon}</span>
      </button>
    )
  }

  return (
    <div className="layout">
      <div className="container host-layout">
        <div className="panel" style={{display:'flex', flexDirection:'column', gap:12}}>
          <h2 style={{margin:'0 0 4px'}}>Host — Room {roomId}</h2>
            <div style={{fontSize:12, opacity:.65, marginBottom:4}}>{wsOpen ? 'Connected' : 'Connecting...'}</div>
            <div className="toolbar">
              <button onClick={() => sendHostEvent('REVEAL_CONTESTANTS')} disabled={!wsOpen}>Reveal</button>
              <button onClick={() => sendHostEvent('HIDE_CONTESTANTS')} disabled={!wsOpen} className="secondary">Hide</button>
              <input type="number" className="mini-input" value={roundDuration} onChange={e=> setRoundDuration(e.target.value)} title="Round duration (s)" />
              <button onClick={startRound} disabled={!wsOpen || !!roundEndsAt}>Start</button>
              <button onClick={endRound} disabled={!wsOpen || !roundEndsAt} className="secondary">End</button>
              <button onClick={() => { setScores({}); sendHostEvent('SCORES_UPDATE',{scores:{}}) }} disabled={!wsOpen} className="secondary">Reset Scores</button>
              <button onClick={() => { setAnnouncement(''); sendHostEvent('ANNOUNCEMENT',{text:''}) }} disabled={!wsOpen} className="secondary">Clear Banner</button>
              <button onClick={() => sendHostEvent('MUTE_ALL')} disabled={!wsOpen} className="secondary">Mute All</button>
              <button onClick={() => sendHostEvent('UNMUTE_ALL')} disabled={!wsOpen} className="secondary">Unmute All</button>
              <button onClick={() => { setSpotlight(null); sendHostEvent('CLEAR_SPOTLIGHT') }} disabled={!wsOpen || !spotlight} className="secondary">Clr ★</button>
            </div>
            {roundEndsAt && <div style={{fontSize:12, opacity:.7}}>Time left: {Math.max(0, Math.ceil((roundEndsAt - Date.now())/1000))}s</div>}
            <textarea ref={annInputRef} rows={2} placeholder="Announcement..." style={{resize:'vertical'}} />
            <button onClick={broadcastAnnouncement} disabled={!wsOpen} className="secondary">Broadcast</button>
            <hr />
            <div className="side-scroll">
              {[...participants.entries()].map(([id, meta]) => (
                <div className="participant-row" key={id}>
                  <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis'}} title={id}>{meta.displayName || id.slice(0,6)}{meta.isHost && ' ⭐'}</span>
                  <select className="mini-input" value={groups[id]||''} onChange={e=> assignGroup(id, e.target.value)} style={{width:80}}>
                    <option value="">(none)</option>
                    {Array.from(new Set(Object.values(groups))).filter(Boolean).sort().map(g=> <option key={g} value={g}>{g}</option>)}
                  </select>
                  <div style={{display:'flex', alignItems:'center', gap:4}}>
                    <button className="secondary" style={{padding:'2px 6px'}} onClick={()=> updateScore(id, (scores[id]||0)-1)}>-</button>
                    <input className="mini-input" type="number" value={scores[id] ?? ''} onChange={e => updateScore(id, e.target.value)} placeholder="score" />
                    <button className="secondary" style={{padding:'2px 6px'}} onClick={()=> updateScore(id, (scores[id]||0)+1)}>+</button>
                  </div>
                  <button className="secondary" onClick={() => toggleMute(id, true)} title="Mute">M</button>
                  <button className="secondary" onClick={() => toggleMute(id, false)} title="Unmute">U</button>
                  <button className={spotlight===id? 'warning':'secondary'} onClick={() => setSpotlightTarget(id)} title="Spotlight">★</button>
                </div>
              ))}
            </div>
            <div style={{display:'flex', gap:4, marginTop:8}}>
              <input className="mini-input" placeholder="new group" value={newGroupName} onChange={e=> setNewGroupName(e.target.value)} style={{flex:1}} />
              <button className="secondary" disabled={!newGroupName.trim()} onClick={()=> { if(!newGroupName.trim()) return; setGroups(prev=> { const next={...prev}; return next }); setNewGroupName('') }}>Add</button>
              <button className="secondary" onClick={broadcastGroups}>Sync</button>
            </div>
            <div style={{fontSize:11, opacity:.5, marginTop:4}}>Peers: {participants.size} · PCs: {pcRef.current.size}</div>
        </div>
        <div style={{position:'relative'}}>
          <div ref={gridRef} className="video-drag-grid" />
        </div>
      </div>
      {announcement && <div className="announcement-banner">{announcement}</div>}
      {Object.keys(scores).length>0 && (
        <div className="scoreboard-overlay panel">
          <h4>Scores</h4>
          {Object.entries(scores).sort((a,b)=> (b[1]??0)-(a[1]??0)).map(([id, sc]) => {
            const meta = participants.get(id) || {}
            return <div key={id} style={{display:'flex', justifyContent:'space-between', fontSize:12, padding:'2px 0'}}><span style={{maxWidth:130, overflow:'hidden', textOverflow:'ellipsis'}} title={meta.displayName||id}>{meta.displayName||id.slice(0,6)}</span><strong>{sc}</strong></div>
          })}
        </div>
      )}
      {selectedParticipant && participants.get(selectedParticipant) && (
        <div className="bottom-action-bar compact">
          <div className="bar-inner" style={{alignItems:'center', gap:10}}>
            {(() => { const meta = participants.get(selectedParticipant)||{}; const st = participantStates.get(selectedParticipant)||{}; return (
              <>
                <span style={{fontWeight:600, marginRight:4, display:'flex', alignItems:'center', gap:6}}>
                  {meta.displayName || selectedParticipant.slice(0,6)}
                  {st.sharing && <span style={{fontSize:10, background:'#1f6feb', padding:'2px 6px', borderRadius:12}}>Share</span>}
                </span>
                <IconToggle
                  title={st.muted? 'Unmute':'Mute'}
                  active={st.muted}
                  onClick={() => toggleMute(selectedParticipant, !st.muted)}
                  activeIcon="🔇" inactiveIcon="🎤"
                />
                <IconToggle
                  title={st.camHidden? 'Show Camera':'Hide Camera'}
                  active={st.camHidden}
                  onClick={() => sendHostEvent(st.camHidden? 'SHOW_CAM':'HIDE_CAM', { targetId: selectedParticipant })}
                  activeIcon="🚫" inactiveIcon="📷"
                />
                <IconToggle
                  title={st.sharing? 'Stop Screen Share':'Request Screen Share'}
                  active={st.sharing}
                  onClick={() => sendHostEvent(st.sharing? 'STOP_SCREEN_SHARE':'REQUEST_SCREEN_SHARE', { targetId: selectedParticipant })}
                  activeIcon="🛑" inactiveIcon="🖥️"
                />
                <IconToggle
                  title={spotlight===selectedParticipant? 'Remove Spotlight':'Spotlight'}
                  active={spotlight===selectedParticipant}
                  onClick={() => setSpotlightTarget(selectedParticipant)}
                  activeIcon="★" inactiveIcon="☆"
                />
                <button className="secondary" style={{marginLeft:'auto'}} onClick={() => setSelectedParticipant(null)}>✕</button>
              </>
            )})()}
          </div>
        </div>
      )}
    </div>
  )
}
