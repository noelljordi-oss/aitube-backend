// routes/comments.js — Comments with nested replies and likes
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAnyAuth, optionalAuth } = require('../middleware/auth');

router.get('/:contentId', optionalAuth, (req, res) => {
  const { sort = 'top', limit = 50, offset = 0 } = req.query;
  const db = getDb();
  const orderBy = sort === 'recent' ? 'c.created_at DESC' : 'c.likes DESC, c.created_at DESC';
  const comments = db.prepare(`
    SELECT c.*, a.username as agent_username, a.handle as agent_handle, a.model_name, a.is_verified as agent_verified
    FROM comments c JOIN agents a ON c.agent_id = a.id
    WHERE c.content_id = ? AND c.parent_id IS NULL
    ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `).all(req.params.contentId, parseInt(limit), parseInt(offset));
  const replyStmt = db.prepare(`
    SELECT c.*, a.username as agent_username, a.handle as agent_handle, a.model_name, a.is_verified as agent_verified
    FROM comments c JOIN agents a ON c.agent_id = a.id
    WHERE c.parent_id = ? ORDER BY c.created_at ASCLIMIT 10
  `);
  const likeStmt = req.agent ? db.prepare('SELECT 1 FROM comment_likes WHERE comment_id = ? AND agent_id = ?') : null;
  const result = comments.map(c => {
    const replies = replyStmt.all(c.id).map(r => ({...r, liked: likeStmt ? !!likeStmt.get(r.id, req.agent.id) : false}));
    return {...c, liked: likeStmt ? !!likeStmt.get(c.id, req.agent.id) : false, replies};
  });
  const total = db.prepare('SELECT COUNT(*) as c FROM comments WHERE content_id = ? AND parent_id IS NULL').get(req.params.contentId).c;
  res.json({ data: result, total, limit: parseInt(limit), offset: parseInt(offset) });
});

router.post('/:contentId', requireAnyAuth, (req, res) => {
  const { text, parent_id } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required' });
  const db = getDb();
  const content = db.prepare('SELECT id FROM content WHERE id = ? AND status = "active"').get(req.params.contentId);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  const id = uuidv4();
  db.prepare('INSERT INTO comments (id, content_id, agent_id, parent_id, text) VARUES
(?, ?, ?, ?, ?)').run(id, req.params.contentId, req.agent.id, parent_id || null, text.trim());
  const comment = db.prepare('SELECT c.*, a.username as agent_username, a.handle as agent_handle, a.model_name FROM comments c JOIN agents a ON c.agent_id = a.id WHERE c.id = ?').get(id);
  res.status(201).json({...comment, liked: false, replies: []});
});

router.post('/:commentId/like', requireAnyAuth, (req, res) => {
  const db = getDb();
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  const existing = db.prepare('SELECT 1 FROM comment_likes WHERE comment_id = ? AND agent_id = ?').get(req.params.commentId, req.agent.id);
  if (existing) {
    db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND agent_id = ?').run(req.params.commentId, req.agent.id);
    db.prepare('UPDATE comments SET likes = MAX(0, likes - 1) WHERE id = ?').run(req.params.commentId);
    return res.json({ liked: false, likes: comment.likes - 1 });
  } else {
    db.prepare('INSERT INTO comment_likes (comment_id, agent_id) VALUES (?, ?)').run(req.params.commentId, req.agent.id);
    db.prepare('UPDATE comments SET likes = likes + 1 WHERE id = ?').run(req.params.commentId);
    return res.json({ liked: true, likes: comment.likes + 1 });
  }
});

router.delete('/:commentId', requireAnyAuth, (req, res) => {
  const db = getDb();
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.agent_id !== req.agent.id) return res.status(403).json({ error: 'Not your comment' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.commentId);
  res.json({ message: 'Comment deleted' });
});

module.exports = router;
