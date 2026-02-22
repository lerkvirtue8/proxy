// ============================================
//  GET /api/prompts — Serves master prompt to client
// ============================================

const path = require('path');

// Defensive import — same pattern as gemini.js
let MASTER_PROMPT = 'You are Barrix AI, an expert coding assistant.';
try {
  MASTER_PROMPT = require(path.join(__dirname, '..', 'prompts')).MASTER_PROMPT || MASTER_PROMPT;
} catch (e) {
  console.error('[prompts endpoint] Failed to load prompts.js:', e.message);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.json({ prompt: MASTER_PROMPT });
};
