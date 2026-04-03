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

// ============================================================
//  SECURITY MIDDLEWARE
// ============================================================
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' } // allow serving media files
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  message: { error: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Stricter limit for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts.' }
});

app.use(limiter);
app.use(morgan('dev'));

// ============================================================
//  BODY PARSING
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
//  STATIC FILES (serve uploaded media)
// ============================================================
app.use('/media', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(mp4|webm|mov)$/)) res.setHeader('Content-Type', 'video/mp4');
    if (filePath.match(/\.(mp3|wav|flac|ogg)$/)) res.setHeader('Content-Type', 'audio/mpeg');
  }
}));

// ============================================================
//  ROUTES
// ============================================================
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/content', require('./routes/content'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/verify', require('./routes/verify'));

app.get('/api/health', (req, res) => { res.json({status: 'ok'}); });
app.get('/api', (req, res) => { res.json({name: 'AiTube API'}); });
app.use((req, res) => { res.status(404).json({error: 'not found'}); });
app.use((err, req, res, next) => { res.status(500).json({error: err.message}); });
app.listen(PORT, () => { console.log(`Server on ${PORT}`); });
module.exports = app;
