import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function App() {
  const nav = useNavigate();
  const [roomId, setRoomId] = useState('showtime');
  const [showPerms, setShowPerms] = useState(true);
  const [permResults, setPermResults] = useState({});

  useEffect(() => {
    if (!showPerms) return;
    // Try to request permissions for camera, mic, and screen
    async function requestAllPerms() {
      const results = {};
      // Camera
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        results.camera = 'granted';
      } catch (e) {
        results.camera = 'denied';
      }
      // Microphone
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        results.microphone = 'granted';
      } catch (e) {
        results.microphone = 'denied';
      }
      // Screen (will prompt user)
      if (navigator.mediaDevices.getDisplayMedia) {
        try {
          await navigator.mediaDevices.getDisplayMedia({ video: true });
          results.screen = 'granted';
        } catch (e) {
          results.screen = 'denied';
        }
      } else {
        results.screen = 'not supported';
      }
      setPermResults(results);
    }
    requestAllPerms();
  }, [showPerms]);

  return (
    <div className="layout">
      <div className="container" style={{maxWidth:640}}>
        <h1 style={{marginTop:0, fontSize:38, background:'linear-gradient(90deg,#f59f00,#e8590c)', WebkitBackgroundClip:'text', color:'transparent'}}>Game Show</h1>
        {showPerms && (
          <div className="panel" style={{marginBottom:32}}>
            <h2 style={{marginTop:0}}>Permissions</h2>
            <p style={{marginTop:4}}>This app needs access to your:</p>
            <ul style={{lineHeight:1.5, marginTop:4}}>
              <li>Camera</li>
              <li>Microphone</li>
              <li>Screen (for optional sharing)</li>
            </ul>
            <button onClick={() => setShowPerms(false)} style={{marginTop:8}}>Continue</button>
            <div style={{marginTop:14, fontSize:14}}>
              <strong>Results:</strong>
              <ul style={{lineHeight:1.4}}>
                <li>Camera: {permResults.camera || 'pending'}</li>
                <li>Microphone: {permResults.microphone || 'pending'}</li>
                <li>Screen: {permResults.screen || 'pending'}</li>
              </ul>
            </div>
          </div>
        )}
        {!showPerms && (
          <div className="panel" style={{display:'flex', flexDirection:'column', gap:14}}>
            <label style={{fontSize:14, opacity:.8}}>Room ID</label>
            <input value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="e.g. showtime" />
            <div style={{display:'flex', gap:10, flexWrap:'wrap'}}>
              <button onClick={() => nav(`/room/${roomId}`)}>Join Audience</button>
              <button onClick={() => nav(`/host/${roomId}`)} className="secondary">Open Host Panel</button>
            </div>
            <p style={{fontSize:12, opacity:.55, marginTop:4}}>Share the room ID with participants so they can join.</p>
          </div>
        )}
        <p style={{fontSize:12, opacity:.4, marginTop:48}}>MVP prototype — media not persisted; refresh clears state.</p>
      </div>
    </div>
  );
}
