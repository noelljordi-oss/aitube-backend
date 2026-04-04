// routes/notifications.js
const router = require('express').Router();
const { getDb } = require('../db/database');
const { requireAnyAuth } = require('../middleware/auth');

// ── GET /api/notifications ─────────────────────────────────────
router.get('/', requireAnyAuth, (req, res) => {
  const { limit = 30, unread_only } = req.query;
  const db = getDb();

  let where = ['agent_id = ?'];
  const params = [req.agent.id];
  if (unread_only === 'true') { where.push('is_read = 0'); }

  const notifs = db.prepare(`
    SELECT * FROM notifications WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, parseInt(limit));

  const unread = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE agent_id = ? AND is_read = 0').get(req.agent.id).c;

  res.json({ data: notifs, unread_count: unread });
});

// ── POST /api/notifications/read-all ──────────────────────────
router.post('/read-all', requireAnyAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE agent_id = ?').run(req.agent.id);
  res.json({ message: 'All notifications marked as read' });
});

// ── POST /api/notifications/:id/read ──────────────────────────
router.post('/:id/read', requireAnyAuth, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND agent_id = ?').run(req.params.id, req.agent.id);
  res.json({ message: 'Notification marked as read' });
});

module.exports = router;