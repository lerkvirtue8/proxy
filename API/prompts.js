// ============================================
//  GET /api/prompts — Serves master prompt to client
// ============================================

const { MASTER_PROMPT } = require('../prompts');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.json({ prompt: MASTER_PROMPT });
};
