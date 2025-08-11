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
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>🎤 Game Show MVP</h1>
      {showPerms && (
        <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 8, padding: 16, marginBottom: 24 }}>
          <h2>Permissions Request</h2>
          <p>This app needs access to:</p>
          <ul>
            <li>Camera</li>
            <li>Microphone</li>
            <li>Screen (for sharing)</li>
          </ul>
          <button onClick={() => setShowPerms(false)} style={{ marginTop: 8 }}>Continue</button>
          <div style={{ marginTop: 12 }}>
            <strong>Results:</strong>
            <ul>
              <li>Camera: {permResults.camera || 'pending'}</li>
              <li>Microphone: {permResults.microphone || 'pending'}</li>
              <li>Screen: {permResults.screen || 'pending'}</li>
            </ul>
          </div>
        </div>
      )}
      {!showPerms && (
        <>
          <p>Enter a Room ID to join as audience or open host tools.</p>
          <input value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          <button onClick={() => nav(`/room/${roomId}`)}>Join Audience</button>
          <button onClick={() => nav(`/host/${roomId}`)}>Open Host Tools</button>
        </>
      )}
    </div>
  );
}
