// ============================================
//  Gemini API Proxy — streaming + non-streaming
//  ENV: GEMINI_API_KEY
// ============================================

const { MASTER_PROMPT } = require('../prompts');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

module.exports = async function handler(req, res) {
  // ---- CORS ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { model, message, stream } = req.body || {};
  if (!model || !message) return res.status(400).json({ error: 'Missing model or message' });

  // Build Google Generative Language API body
  const body = {
    contents: [{ role: 'user', parts: [{ text: message }] }],
    systemInstruction: { parts: [{ text: MASTER_PROMPT }] },
    generationConfig: {
      temperature: 1.0,
      maxOutputTokens: 65536
    }
  };

  try {
    if (stream) {
      // ---- Streaming path ----
      const url = `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        return res.status(upstream.status).json({ error: 'Gemini ' + upstream.status + ': ' + errText });
      }

      // Stream plain text to client (client concatenates raw chunks)
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines, extract text parts, write plain text to client
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) res.write(text);
          } catch (_) { /* skip malformed JSON */ }
        }
      }

      // Flush any remaining data in buffer
      if (buffer.startsWith('data: ')) {
        const raw = buffer.slice(6).trim();
        if (raw && raw !== '[DONE]') {
          try {
            const parsed = JSON.parse(raw);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) res.write(text);
          } catch (_) { /* skip */ }
        }
      }

      return res.end();

    } else {
      // ---- Non-streaming path ----
      const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        return res.status(upstream.status).json({ error: 'Gemini ' + upstream.status + ': ' + errText });
      }

      const data = await upstream.json();
      // Return in the format the client expects
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.json({ text, candidates: data.candidates });
    }
  } catch (e) {
    console.error('Gemini proxy error:', e);
    return res.status(500).json({ error: e.message || 'Internal proxy error' });
  }
};
