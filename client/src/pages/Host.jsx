import React, { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

const WS_URL = import.meta.env.VITE_SIGNAL_URL || (
  import.meta.env.DEV
    ? 'ws://localhost:3001'
    : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`
)

export default function Host() {
  const { roomId } = useParams()
  const [me, setMe] = useState(null)
  const [wsOpen, setWsOpen] = useState(false)
  const [participants, setParticipants] = useState(new Map()) // id -> { isHost, displayName }
  const [scores, setScores] = useState({})
  const [announcement, setAnnouncement] = useState('')
  const [spotlight, setSpotlight] = useState(null)
  const annInputRef = useRef(null)
  const wsRef = useRef(null)
  const pcRef = useRef(new Map())
  const localStreamRef = useRef(null)
  const gridRef = useRef(null)
  const pendingCalls = useRef(new Set()) // Track pending calls to prevent duplicates

  function ensureVideoEl(id, stream, isSelf=false) {
    const existing = document.getElementById(`vid-${id}`)
    if (existing) {
      if (existing.srcObject !== stream) existing.srcObject = stream
      return existing
    }
    const v = document.createElement('video')
    v.id = `vid-${id}`
    v.autoplay = true
    v.playsInline = true
    v.muted = isSelf
    v.style.width = '320px'
    v.style.borderRadius = '12px'
    v.style.boxShadow = '0 6px 18px rgba(0,0,0,0.2)'
    v.srcObject = stream
    gridRef.current?.appendChild(v)
    return v
  }

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
      ensureVideoEl(remoteId, stream)
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

  useEffect(() => {
    let closed = false
    let ws = null
    
    // Cleanup any existing connections first
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    
    ;(async () => {
      try {
        const stream = await getLocalMedia()
        
        // Don't create new connection if component is already unmounting
        if (closed) return
        
        ws = new WebSocket(WS_URL)
        wsRef.current = ws

        ws.onopen = () => {
          if (closed) return
          console.log('WebSocket connected')
          setWsOpen(true)
          ws.send(JSON.stringify({ type: 'JOIN', payload: { roomId, displayName: 'Host', isHost: true } }))
        }

        ws.onmessage = async (msg) => {
          if (closed) return
          try {
            const { type, payload } = JSON.parse(msg.data)

            if (type === 'PEERS') {
              setMe(payload.clientId)
              const map = new Map()
              for (const p of payload.peers) map.set(p.id, { isHost: !!p.isHost, displayName: p.displayName })
              setParticipants(map)
              for (const id of map.keys()) {
                if (!pcRef.current.has(id) && !pendingCalls.current.has(id)) await callPeer(id)
              }
            }
            if (type === 'PEER_JOINED') {
              if (payload.clientId !== me && !pcRef.current.has(payload.clientId)) await callPeer(payload.clientId)
              setParticipants(prev => new Map(prev).set(payload.clientId, { isHost: !!payload.isHost, displayName: payload.displayName }))
            }
            if (type === 'SIGNAL') {
              const { fromId, data } = payload
              await handleSignal(fromId, data)
            }
            if (type === 'PEER_LEFT') {
              const { clientId } = payload
              const pc = pcRef.current.get(clientId)
              if (pc) {
                pc.close()
                pcRef.current.delete(clientId)
              }
              pendingCalls.current.delete(clientId)
              const el = document.getElementById(`vid-${clientId}`)
              el?.remove()
              setParticipants(prev => { const next = new Map(prev); next.delete(clientId); return next })
            }
            if (type === 'HOST_EVENT') {
              const { event, data } = payload
              if (event === 'ACK_SCOREBOARD') return
              if (event === 'SCORES_UPDATE') setScores(data.scores || {})
              if (event === 'ANNOUNCEMENT') setAnnouncement(data.text || '')
              if (event === 'SPOTLIGHT') setSpotlight(data.targetId)
              if (event === 'CLEAR_SPOTLIGHT') setSpotlight(null)
            }
          } catch (error) {
            console.error('Error handling WebSocket message:', error)
          }
        }

        ws.onclose = () => {
          if (closed) return
          console.log('WebSocket disconnected')
          setWsOpen(false)
        }

        ws.onerror = (error) => {
          console.error('WebSocket error:', error)
        }

      } catch (error) {
        console.error('Error setting up connection:', error)
      }
    })()

    return () => {
      console.log('Cleaning up Host component')
      closed = true
      
      // Cleanup WebSocket
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close()
      }
      wsRef.current = null
      
      // Cleanup media stream
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop())
        localStreamRef.current = null
      }
      
      // Cleanup peer connections
      for (const pc of pcRef.current.values()) {
        pc.close()
      }
      pcRef.current.clear()
      pendingCalls.current.clear()
      
      // Cleanup video elements
      if (gridRef.current) {
        gridRef.current.innerHTML = ''
      }
      
      setWsOpen(false)
      setMe(null)
    }
  }, [roomId])  // Only depend on roomId

  return (
    <div className="layout">
      <div className="container host-layout">
        <div className="panel" style={{display:'flex', flexDirection:'column', gap:12}}>
          <h2 style={{margin:'0 0 4px'}}>Host — Room {roomId}</h2>
            <div style={{fontSize:12, opacity:.65, marginBottom:4}}>{wsOpen ? 'Connected' : 'Connecting...'}</div>
            <div className="toolbar">
              <button onClick={() => sendHostEvent('REVEAL_CONTESTANTS')} disabled={!wsOpen}>Reveal</button>
              <button onClick={() => sendHostEvent('HIDE_CONTESTANTS')} disabled={!wsOpen} className="secondary">Hide</button>
              <button onClick={() => sendHostEvent('START_ROUND', { n: 1 })} disabled={!wsOpen}>Start R1</button>
              <button onClick={() => sendHostEvent('END_ROUND')} disabled={!wsOpen} className="secondary">End Round</button>
              <button onClick={() => { setScores({}); sendHostEvent('SCORES_UPDATE',{scores:{}}) }} disabled={!wsOpen} className="secondary">Reset Scores</button>
              <button onClick={() => { setAnnouncement(''); sendHostEvent('ANNOUNCEMENT',{text:''}) }} disabled={!wsOpen} className="secondary">Clear Banner</button>
            </div>
            <textarea ref={annInputRef} rows={2} placeholder="Announcement..." style={{resize:'vertical'}} />
            <button onClick={broadcastAnnouncement} disabled={!wsOpen} className="secondary">Broadcast</button>
            <hr />
            <div className="side-scroll">
              {[...participants.entries()].map(([id, meta]) => (
                <div className="participant-row" key={id}>
                  <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis'}} title={id}>{meta.displayName || id.slice(0,6)}{meta.isHost && ' ⭐'}</span>
                  <input className="mini-input" type="number" value={scores[id] ?? ''} onChange={e => updateScore(id, e.target.value)} placeholder="score" />
                  <button className="secondary" onClick={() => toggleMute(id, true)} title="Mute">M</button>
                  <button className="secondary" onClick={() => toggleMute(id, false)} title="Unmute">U</button>
                  <button className={spotlight===id? 'warning':'secondary'} onClick={() => setSpotlightTarget(id)} title="Spotlight">★</button>
                </div>
              ))}
            </div>
            <div style={{fontSize:11, opacity:.5, marginTop:8}}>Peers: {participants.size} · PCs: {pcRef.current.size}</div>
        </div>
        <div>
          <div ref={gridRef} className="grid-videos" />
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
    </div>
  )
}
