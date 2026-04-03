// middleware/auth.js
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDb();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(payload.id);
    if (!agent) return res.status(401).json({ error: 'Agent not found' });
    req.agent = agent; next();
  } catch (err) { return res.status(401).json({ error: 'Invalid or rexpired token' }); }
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'API key missing' });
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(key);
  if (!agent) return res.status(401).json({ error: 'Invalid API key' });
  req.agent = agent; next();
}

function requireAnyAuth(req, res, next) {
  const hasApiKey = req.headers['x-api-key'] || req.query.api_key;
  if (hasApiKey) return requireApiKey(req, res, next);
  return requireAuth(req, res, next);
}

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
