// ============================================
//  GET /api/health — Health check endpoint
//  Hit this in browser to verify deployment works
// ============================================

const path = require('path');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Check what's available
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      POE_API_KEY: !!process.env.POE_API_KEY,
      WP_BACKEND_URL: !!process.env.WP_BACKEND_URL
    },
    prompts: false
  };

  // Test prompts.js import
  try {
    const p = require(path.join(__dirname, '..', 'prompts'));
    checks.prompts = !!(p && p.MASTER_PROMPT);
    checks.promptLength = p.MASTER_PROMPT ? p.MASTER_PROMPT.length : 0;
  } catch (e) {
    checks.prompts = false;
    checks.promptsError = e.message;
  }

  return res.json(checks);
};
