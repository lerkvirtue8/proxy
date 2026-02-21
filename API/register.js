// ============================================
//  Auth Register Proxy — forwards to WordPress
//  ENV: WP_BACKEND_URL  (e.g. https://dirtmercy.com)
// ============================================

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var wpUrl = process.env.WP_BACKEND_URL;
  if (!wpUrl) return res.status(500).json({ error: 'WP_BACKEND_URL not configured' });

  var { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    var upstream = await fetch(wpUrl + '/wp-json/dirtmercy/v1/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    var data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }
    if (data.token && !data.authHeader) {
      data.authHeader = 'Bearer ' + data.token;
    }
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Register proxy error' });
  }
};
