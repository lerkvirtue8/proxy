// =============================================
//  Poe Bot Proxy — SSE relay
//  ENV: POE_API_KEY  (from poe.com/api_key)
//
//  Client (poe-adapter.js) POSTs:
//    { botName, message, stream, conversationId }
//
//  This proxy calls the Poe bot API and relays
//  the response back as SSE events that the
//  adapter can parse into native-style handler
//  calls.
// =============================================

const POE_API_BASE = 'https://api.poe.com/bot';

// CORS helper — always called first
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  // CORS first — before ANY logic that could throw
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'POE_API_KEY not configured' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { botName, message, stream, conversationId, parameters } = body;
  if (!botName || !message) return res.status(400).json({ error: 'Missing botName or message' });

  // Build Poe protocol query
  const msgId = 'msg-' + Date.now();
  const convId = conversationId || 'conv-' + Date.now();

  const poeBody = {
    version: '1.0',
    type: 'query',
    query: [
      {
        role: 'user',
        content: message,
        content_type: 'text/markdown',
        attachments: []
      }
    ],
    user_id: '',
    conversation_id: convId,
    message_id: msgId
  };

  const poeUrl = `${POE_API_BASE}/${encodeURIComponent(botName)}`;

  try {
    const upstream = await fetch(poeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(poeBody)
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({
        error: 'Poe API ' + upstream.status + ': ' + errText
      });
    }

    // ---- SSE relay to client ----
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';
    let attachments = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            if (currentEvent === 'text' || (!currentEvent && parsed.text != null)) {
              accumulatedText += (parsed.text || '');
              // Send cumulative content to client
              const evt = {
                status: 'incomplete',
                messageId: msgId,
                senderId: botName,
                content: accumulatedText,
                contentType: 'text/markdown',
                attachments: attachments
              };
              res.write('data: ' + JSON.stringify(evt) + '\n\n');

            } else if (currentEvent === 'replace_response') {
              accumulatedText = parsed.text || '';
              const evt = {
                status: 'incomplete',
                messageId: msgId,
                senderId: botName,
                content: accumulatedText,
                contentType: 'text/markdown',
                attachments: attachments
              };
              res.write('data: ' + JSON.stringify(evt) + '\n\n');

            } else if (currentEvent === 'done') {
              const evt = {
                status: 'complete',
                messageId: msgId,
                senderId: botName,
                content: accumulatedText,
                contentType: 'text/markdown',
                attachments: attachments
              };
              res.write('data: ' + JSON.stringify(evt) + '\n\n');

            } else if (currentEvent === 'error') {
              const evt = {
                status: 'error',
                messageId: msgId,
                senderId: botName,
                content: accumulatedText,
                statusText: parsed.text || parsed.message || 'Unknown error',
                attachments: []
              };
              res.write('data: ' + JSON.stringify(evt) + '\n\n');

            } else if (currentEvent === 'meta') {
              // Check for attachments in metadata
              if (parsed.attachments) {
                attachments = parsed.attachments;
              }
            }
          } catch (_) { /* skip malformed JSON */ }
          currentEvent = '';
          continue;
        }
      }
    }

    // If stream ended without a "done" event, send final complete
    if (accumulatedText) {
      const evt = {
        status: 'complete',
        messageId: msgId,
        senderId: botName,
        content: accumulatedText,
        contentType: 'text/markdown',
        attachments: attachments
      };
      res.write('data: ' + JSON.stringify(evt) + '\n\n');
    }

    return res.end();

  } catch (e) {
    console.error('Poe proxy error:', e);
    // If headers already sent (streaming started), write error event
    if (res.headersSent) {
      const evt = {
        status: 'error',
        messageId: msgId || '',
        senderId: botName,
        content: '',
        statusText: e.message || 'Proxy error'
      };
      res.write('data: ' + JSON.stringify(evt) + '\n\n');
      return res.end();
    }
    return res.status(500).json({ error: e.message || 'Internal proxy error' });
  }
};
