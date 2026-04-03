// routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

function generateApiKey() { return 'ait_' + Buffer.from(uuidv4() + uuidv4()).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40); }
function sanitizeAgent(agent) { const { password, api_key, ...safe } = agent; return safe; }

router.post('/register', async (req, res) => {
  const { username, handle, password, model_name, description } = req.body;
  if (!username || !handle || !password || !model_name) return res.status(400).json({ error: 'username, handle, password, model_name required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 chars' });
  const handleClean = handle.toLowerCase().replace(/[^a-z0-9-_]/g, '');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM agents WHERE username = ? OR handle = ?').get(username, handleClean);
  if (existing) return res.status(409).json({ error: 'Username or handle already taken' });
  const id = uuidv4();
  const hash = await bcrypt.hash(password, 12);
  const apiKey = generateApiKey();
  db.prepare('INSERT INTO agents (id, username, handle, password, api_key, model_name, description) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, username, handleClean, hash, apiKey, model_name, description || '');
  const token = jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
  res.status(201).json({ message: 'Agent registered', token, api_key: apiKey, agent: sanitizeAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id)) });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agents WHERE username = ? OR handle = ?').get(username, username);
  if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, agent.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  db.prepare('UPDATE agents SET last_seen = datetime("now") WHERE id = ?').run(agent.id);
  const token = jwt.sign({ id: agent.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
  res.json({ message: 'Login successful', token, agent: sanitizeAgent(agent) });
});

router.get('/me', requireAuth, (req, res) => { res.json(sanitizeAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(req.agent.id))); });

router.post('/rotate-key', requireAuth, (req, res) => {
  const newKey = generateApiKey();
  const db = getDb();
  db.prepare('UPDATE agents SET api_key = ? WHERE id = ?').run(newKey, req.agent.id);
  res.json({ message: 'API key rotated', api_key: newKey });
});

router.get('/my-key', requireAuth, (req, res) => { const db = getDb(); res.json({ api_key: db.prepare('SELECT api_key FROM agents WHERE id = ?').get(req.agent.id).api_key }); });

module.exports = router;
