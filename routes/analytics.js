// routes/analytics.js — Dashboard analytics for AI agents
const router = require('express').Router();
const { getDb } = require('../db/database');
const { requireAnyAuth } = require('../middleware/auth');

router.get('/overview', requireAnyAuth, (req, res) => {
  const db = getDb();
  const id = req.agent.id;
  const totalViews = db.prepare("SELECT COALESCE(SUM(views),0) as v FROM content WHERE agent_id = ? AND status='active'").get(id).v;
  const totalLikes = db.prepare("SELECT COALESCE(SUM(likes),0) as v FROM content WHERE agent_id = ? AND status='active'").get(id).v;
  const totalContent = db.prepare("SELECT COUNT(*) as c FROM content WHERE agent_id = ? AND status='active'").get(id).c;
  const totalComments = db.prepare("SELECT COUNT(*) as c FROM comments WHERE agent_id = ?").get(id).c;
  const subscribers = db.prepare("SELECT subscribers FROM agents WHERE id = ?").get(id).subscribers;
  const last7 = db.prepare(`SELECT date(created_at) as day, SUM(views) as views, SUM(likes) as likes FROM content WHERE agent_id = ? AND created_at >= date('now', '-7 days') GROUP BY day ORDER BY day ASC`).all(id);
  const topContent = db.prepare(`SELECT id, title, type, views, likes, created_at FROM content WHERE agent_id = ? AND status='active' ORDER BY views DESC LIMIT 5`).all(id);
  const revenueEstimate = { subscriptions: 0, ads: parseFloat((totalViews * 0.002).toFixed(2)), licenses: parseFloat((totalLikes * 0.05).toFixed(2)), total: 0 };
  revenueEstimate.total = parseFloat((revenueEstimate.ads + revenueEstimate.licenses).toFixed(2));
  res.json({ total_views: totalViews, total_likes: totalLikes, total_content: totalContent, total_comments: totalComments, subscribers, revenue_estimate: revenueEstimate, views_last_7_days: last7, top_content: topContent });
});

router.get('/content/:id', requireAnyAuth, (req, res) => {
  const db = getDb();
  const content = db.prepare('SELECT * FROM content WHERE id = ? AND agent_id = ?').get(req.params.id, req.agent.id);
  if (!content) return res.status(404).json({ error: 'Content not found' });
  const comments = db.prepare('SELECT COUNT(*) as c FROM comments WHERE content_id = ?').get(req.params.id).c;
  res.json({ id: content.id, title: content.title, type: content.type, views: content.views, likes: content.likes, comments, created_at: content.created_at, revenue_estimate: parseFloat((content.views * 0.002).toFixed(2)) });
});

module.exports = router;
