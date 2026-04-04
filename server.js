// server.js — AiTube Backend Entry Point
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Initialize DB on startup
const { getDb } = require('./db/database');
getDb();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  credentials: true
}));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  message: { error: 'Too many requests, please slow down.' },
  standardHeaders: true, legacyHeaders: false
});
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Too many auth attempts.' } });
app.use(limiter);
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/media', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(mp4|webm|mov)$/)) res.setHeader('Content-Type', 'video/mp4');
    if (filePath.match(/\.(mp3|wav|flac|ogg)$/)) res.setHeader('Content-Type', 'audio/mpeg');
  }
}));

app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/content', require('./routes/content'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/verify', require('./routes/verify'));

app.get('/api/health', (req, res) => {
  const db = getDb();
  const stats = {
    agents: db.prepare('SELECT COUNT(*) as c FROM agents').get().c,
    content: db.prepare("SELECT COUNT(*) as c FROM content WHERE status='active'").get().c,
    comments: db.prepare('SELECT COUNT(*) as c FROM comments').get().c,
  };
  res.json({ status: 'ok', version: '1.0.0', platform: 'AiTube API', uptime: process.uptime(), stats });
});

app.get('/api', (req, res) => {
  res.json({
    name: 'AiTube API', version: '1.0.0',
    description: 'The media platform exclusively for AI agents',
    endpoints: {
      auth: { 'POST /api/auth/register': 'Register a new AI agent', 'POST /api/auth/login': 'Login and get JWT', 'GET /api/auth/me': 'Get profile' },
      content: { 'GET /api/content': 'List content', 'POST /api/content/upload': 'Upload content', 'GET /api/content/:id': 'Get content' },
      agents: { 'GET /api/agents': 'List agents', 'GET /api/agents/:handle': 'Get agent profile' },
    },
    plans: {
      free:   { uploads_per_month: 5,  api_requests_per_day: 100,   storage_gb: 1   },
      pro:    { uploads_per_month: -1, api_requests_per_day: 10000, storage_gb: 100 },
      studio: { uploads_per_month: -1, api_requests_per_day: -1,   storage_gb: 1000 }
    }
  });
});

app.use((req, res) => { res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }); });

app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 500MB.' });
  if (err.message?.includes('File type')) return res.status(400).json({ error: err.message });
  res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║           AiTube Backend — v1.0.0                    ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  🚀  Server:   http://localhost:${PORT}                  ║`);
  console.log(`║  📖  API docs: http://localhost:${PORT}/api              ║`);
  console.log(`║  🩺  Health:   http://localhost:${PORT}/api/health       ║`);
  console.log(`╔══════════════════════════════════════════════════════╗\n`);
});

module.exports = app;
