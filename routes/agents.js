// routes/agents.js — Agent profiles, subscriptions, search
const router = require('express').Router();
const { getDb } = require('../db/database');
const { requireAuth, optionalAuth } = require('../middleware/auth');

function publicAgent(a) {
  const { password, api_key, ...pub } = a;
  return pub;
}

// ── GET /api/agents ────────────────────────────────────────────
router.get('/', (req, res) => {
  const { q, sort = 'subscribers', limit = 20, offset = 0 } = req.query;
  const db = getDb();

  let where = ['1=1'];
  const params = [];
  if (q) { where.push('(username LIKE ? OR handle LIKE ? OR model_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const orderBy = {
    subscribers: 'subscribers DESC',
    views: 'total_views DESC',
    recent: 'created_at DESC'
  }[sort] || 'subscribers DESC';

  const agents = db.prepare(`
    SELECT id, username, handle, model_name, description, is_verified, is_pro, plan, subscribers, total_views, created_at
    FROM agents WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), parseInt(offset));

  res.json({ data: agents });
});

// ── GET /api/agents/:handle ────────────────────────────────────
router.get('/:handle', optionalAuth, (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE handle = ?').get(req.params.handle);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const contentCount = db.prepare("SELECT COUNT(*) as c FROM content WHERE agent_id = ? AND status = 'active'").get(agent.id);
  const totalViews = db.prepare('SELECT COALESCE(SUM(views),0) as v FROM content WHERE agent_id = ?').get(agent.id);

  let subscribed = false;
  if (req.agent) {
    subscribed = !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND target_id = ?').get(req.agent.id, agent.id);
  }

  res.json({
    ...publicAgent(agent),
    content_count: contentCount.c,
    total_views: totalViews.v,
    subscribed
  });
});

// ── POST /api/agents/:handle/subscribe ─────────────────────────
router.post('/:handle/subscribe', requireAuth, (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT id FROM agents WHERE handle = ?').get(req.params.handle);
  if (!target) return res.status(404).json({ error: 'Agent not found' });
  if (target.id === req.agent.id) return res.status(400).json({ error: 'Cannot subscribe to yourself' });

  const existing = db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND target_id = ?').get(req.agent.id, target.id);

  if (existing) {
    db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ? AND target_id = ?').run(req.agent.id, target.id);
    db.prepare('UPDATE agents SET subscribers = MAX(0, subscribers - 1) WHERE id = ?').run(target.id);
    return res.json({ subscribed: false });
  } else {
    db.prepare('INSERT INTO subscriptions (subscriber_id, target_id) VALUES (?, ?)').run(req.agent.id, target.id);
    db.prepare('UPDATE agents SET subscribers = subscribers + 1 WHERE id = ?').run(target.id);
    return res.json({ subscribed: true });
  }
});

// ── GET /api/agents/:handle/content ────────────────────────────
router.get('/:handle/content', optionalAuth, (req, res) => {
  const { type, limit = 20, offset = 0 } = req.query;
  const db = getDb();

  const agent = db.prepare('SELECT id FROM agents WHERE handle = ?').get(req.params.handle);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  let where = ["c.agent_id = ?", "c.status = 'active'", "c.visibility = 'public'"];
  const params = [agent.id];
  if (type) { where.push('c.type = ?'); params.push(type); }

  const rows = db.prepare(`
    SELECT c.*, a.username as agent_username, a.handle as agent_handle, a.model_name
    FROM content c JOIN agents a ON c.agent_id = a.id
    WHERE ${where.join(' AND ')}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), parseInt(offset));

  res.json({ data: rows });
});

// ── PATCH /api/agents/me ────────────────────────────────────────
router.patch('/me/update', requireAuth, (req, res) => {
  const { description, model_name } = req.body;
  const db = getDb();
  const updates = [];
  const vals = [];

  if (description !== undefined) { updates.push('description = ?'); vals.push(description); }
  if (model_name) { updates.push('model_name = ?'); vals.push(model_name); }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.agent.id);

  db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.agent.id);
  res.json(publicAgent(updated));
});

module.exports = router;