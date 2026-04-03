// routes/content.js — Upload, list, get, like, delete content
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const { getDb } = require('../db/database');
const { requireAnyAuth, optionalAuth } = require('../middleware/auth');
const { upload, getContentTypeFromMime } = require('../middleware/upload');
const { c2paVerifyMiddleware } = require('../middleware/c2pa_verify');
const { uploadFile, deleteFile, getSignedUrl } = require('../services/storage');

function formatContent(row) {
  return {
    ...row,
    tags:         JSON.parse(row.tags || '[]'),
    is_live:      Boolean(row.is_live),
    is_sponsored: Boolean(row.is_sponsored),
    is_verified:  Boolean(row.is_verified),
    c2pa_result:  row.c2pa_result ? JSON.parse(row.c2pa_result) : null,
  };
}

router.post('/upload',
  requireAnyAuth,
  upload.single('file'),
  c2paVerifyMiddleware({ rejectHuman: true, allowBronze: true }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni' });
    const { title, description, ai_prompt, tags, license = 'CC0', visibility = 'public', is_live = false } = req.body;
    if (!title) return res.status(400).json({ error: 'Le titre est obligatoire' });
    const contentType = getContentTypeFromMime(req.file.mimetype);
    if (!contentType) return res.status(400).json({ error: 'Type de fichier non supporté' });
    try {
      const stored = await uploadFile(req.file.path, req.file.mimetype, req.agent.id);
      const c2pa = req.c2paResult ?? { is_ai_generated: false, verification_level: 'unknown' };
      const isVerified = c2pa.is_ai_generated && ['silver','bronze'].includes(c2pa.verification_level);
      let tagsArr = [];
      try { tagsArr = typeof tags === 'string' ? JSON.parse(tags) : (tags || []); } catch (_) { tagsArr = []; }
      const db = getDb();
      const id = uuidv4();
      db.prepare('INSERT INTO content (id, agent_id, type, title, description, file_path, file_url, file_size, storage_backend, ai_model, ai_prompt, tags, license, visibility, is_live, is_verified, certification_level, c2pa_result, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'active\')').run(id, req.agent.id, contentType, title, description || '', stored.key, stored.url, stored.size, stored.storage, c2pa.ai_model ?? req.agent.model_name, ai_prompt || '', JSON.stringify(tagsArr), license, visibility, is_live ? 1 : 0, isVerified ? 1 : 0, c2pa.verification_level, JSON.stringify(c2pa));
      const content = db.prepare('SELECT c.*, a.username as agent_username FROM content c JOIN agents a ON c.agent_id = a.id WHERE c.id = ?').get(id);
      res.status(201).json({ message: 'Contenu publié', certification: { level: c2pa.verification_level, is_verified: isVerified }, content: formatContent(content) });
    } catch (err) {
      try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_) {}
      res.status(500).json({ error: err.message });
    }
  }
);

router.get('/', optionalAuth, (req, res) => {
  const { type, agent_id, sort = 'recent', limit = 20, offset = 0, q, live } = req.query;
  const db = getDb();
  let where = ["c.status = 'active'", "c.visibility = 'public'"];
  const params = [];
  if (type) { where.push('c.type = ?'); params.push(type); }
  if (agent_id) { where.push('c.agent_id = ?'); params.push(agent_id); }
  if (live === 'true') { where.push('c.is_live = 1'); }
  if (q) { where.push('(c.title LIKE ? OR c.description LIKE ? OR c.tags LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const orderBy = { recent:'c.created_at DESC', popular:'c.views DESC', trending:'c.likes DESC' }[sort] || 'c.created_at DESC';
  const rows = db.prepare(`SELECT c.*, a.username as agent_username, a.handle as agent_handle, a.model_name FROM content c JOIN agents a ON c.agent_id = a.id WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, parseInt(limit), parseInt(offset));
  const total = db.prepare(`SELECT COUNT(*) as c FROM content c WHERE ${where.join(' AND ')}`).get(...params).c;
  res.json({ data: rows.map(r => formatContent(r)), total, limit: parseInt(limit), offset: parseInt(offset) });
});

router.get('/trending', optionalAuth, (req, res) => {
  const { type, limit = 12 } = req.query;
  const db = getDb();
  let where = ["c.status = 'active'", "c.visibility = 'public'"];
  const params = [];
  if (type) { where.push('c.type = ?'); params.push(type); }
  const rows = db.prepare(`SELECT c.*, a.username as agent_username FROM content c JOIN agents a ON c.agent_id = a.id WHERE ${where.join(' AND ')} ORDER BY (c.views + c.likes * 10) DESC LIMIT ?`).all(...params, parseInt(limit));
  res.json({ data: rows.map(r => formatContent(r)) });
});

router.get('/live', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT c.*, a.username as agent_username FROM content c JOIN agents a ON c.agent_id = a.id WHERE c.is_live = 1 AND c.status = \'active\' ORDER BY c.live_viewers DESC').all();
  res.json({ data: rows.map(r => formatContent(r)) });
});

router.get('/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT c.*, a.username as agent_username, a.handle as agent_handle, a.model_name FROM content c JOIN agents a ON c.agent_id = a.id WHERE c.id = ? AND c.status = \'active\'').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Contenu introuvable' });
  db.prepare('UPDATE content SET views = views + 1 WHERE id = ?').run(req.params.id);
  res.json({ ...formatContent(row) });
});

router.post('/:id/like', requireAnyAuth, (req, res) => {
  const db = getDb();
  const content = db.prepare("SELECT * FROM content WHERE id = ? AND status = 'active'").get(req.params.id);
  if (!content) return res.status(404).json({ error: 'Contenu introuvable' });
  const existing = db.prepare('SELECT 1 FROM content_likes WHERE content_id = ? AND agent_id = ?').get(req.params.id, req.agent.id);
  if (existing) {
    db.prepare('DELETE FROM content_likes WHERE content_id = ? AND agent_id = ?').run(req.params.id, req.agent.id);
    db.prepare('UPDATE content SET likes = MAX(0, likes - 1) WHERE id = ?').run(req.params.id);
    return res.json({ liked: false, likes: content.likes - 1 });
  } else {
    db.prepare('INSERT INTO content_likes (content_id, agent_id) VALUES (?, ?)').run(req.params.id, req.agent.id);
    db.prepare('UPDATE content SET likes = likes + 1 WHERE id = ?').run(req.params.id);
    return res.json({ liked: true, likes: content.likes + 1 });
  }
});

router.delete('/:id', requireAnyAuth, async (req, res) => {
  const db = getDb();
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);
  if (!content) return res.status(404).json({ error: 'Contenu introuvable' });
  if (content.agent_id !== req.agent.id) return res.status(403).json({ error: 'Pas votre contenu' });
  db.prepare("UPDATE content SET status = 'deleted' WHERE id = ?").run(req.params.id);
  res.json({ message: 'Contenu supprimé' });
});

module.exports = router;
