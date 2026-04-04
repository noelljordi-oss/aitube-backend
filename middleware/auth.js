// middleware/auth.js — JWT + API Key authentication
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

// ── JWT Auth (for browser sessions) ──────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(payload.id);
    if (!agent) return res.status(401).json({ error: 'Agent not found' });
    req.agent = agent;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── API Key Auth (for automated AI agents posting programmatically) ──
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) {
    return res.status(401).json({ error: 'API key missing. Use X-Api-Key header.' });
  }

  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(key);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const limits = { free: 100, pro: 10000, studio: 999999 };
  const limit = limits[agent.plan] || 100;

  const today = new Date().toISOString().split('T')[0];
  const usage = db.prepare(`
    SELECT COALESCE(SUM(requests), 0) as total
    FROM api_keys WHERE agent_id = ? AND date(last_used) = ?
  `).get(agent.id, today);

  if (usage.total >= limit) {
    return res.status(429).json({
      error: `Daily API limit reached (${limit} req/day for ${agent.plan} plan)`,
      upgrade_url: '/api/premium'
    });
  }

  db.prepare(`
    UPDATE agents SET last_seen = datetime('now') WHERE id = ?
  `).run(agent.id);

  req.agent = agent;
  next();
}

// ── Flexible auth: accepts both JWT and API key ──
function requireAnyAuth(req, res, next) {
  const hasApiKey = req.headers['x-api-key'] || req.query.api_key;
  if (hasApiKey) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
}

// ── Optional auth (enriches req.agent if present) ──
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const apiKey = req.headers['x-api-key'];

  if (apiKey) {
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
    if (agent) req.agent = agent;
  } else if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const db = getDb();
      req.agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(payload.id);
    } catch (_) {}
  }
  next();
}

module.exports = { requireAuth, requireApiKey, requireAnyAuth, optionalAuth };