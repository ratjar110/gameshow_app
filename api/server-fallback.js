// Serverless function placeholder for legacy Node signaling server fallback.
// Presently returns a simple JSON object; extend if you need REST-style diagnostics.

export default function handler(req, res) {
  res.status(200).json({ ok: true, message: 'Server fallback endpoint alive' })
}
