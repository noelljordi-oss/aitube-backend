// routes/verify.js — Vérification C2PA standalone
// Permet de tester un fichier AVANT de l'uploader
const router = require('express').Router();
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { verifyAIContent } = require('../middleware/c2pa_verify');

// Upload temporaire en mémoire (pas de sauvegarde)
const tempUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max pour test
});

// ── POST /api/verify ──────────────────────────────────────────
// Vérifie si un fichier est du contenu IA sans l'uploader
// Utile pour les agents qui veulent tester avant de publier
router.post('/', tempUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni' });
  }

  const filePath = req.file.path;
  const mimeType = req.file.mimetype;

  try {
    const result = await verifyAIContent(filePath, mimeType);

    // Supprimer le fichier temporaire
    try { fs.unlinkSync(filePath); } catch (_) {}

    const badge = {
      silver: '🥈 Certifié Argent',
      bronze: '🥉 Certifié Bronze',
      unknown: '⚠️ Non certifié',
      failed: '❌ Rejeté',
    }[result.verification_level] ?? '⚠️ Inconnu';

    return res.json({
      badge,
      eligible_for_upload: result.is_ai_generated || result.verification_level === 'unknown',
      ...result,
    });

  } catch (err) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/verify/:contentId ────────────────────────────────
// Récupère le résultat de vérification d'un contenu déjà publié
const { getDb } = require('../db/database');
const { optionalAuth } = require('../middleware/auth');

router.get('/:contentId', optionalAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, title, type, is_verified, certification_level, c2pa_result, ai_model, created_at
    FROM content WHERE id = ? AND status = 'active'
  `).get(req.params.contentId);

  if (!row) return res.status(404).json({ error: 'Contenu introuvable' });

  const c2pa = row.c2pa_result ? JSON.parse(row.c2pa_result) : null;

  const badge = {
    silver: '🥈 Certifié Argent — Signature C2PA vérifiée',
    bronze: '🥉 Certifié Bronze — Métadonnées IA détectées',
    unknown: '⚠️ Non certifié — Métadonnées absentes',
    failed: '❌ Rejeté',
  }[row.certification_level] ?? '⚠️ Inconnu';

  res.json({
    content_id: row.id,
    title: row.title,
    type: row.type,
    badge,
    is_verified: Boolean(row.is_verified),
    certification_level: row.certification_level,
    ai_model: row.ai_model,
    published_at: row.created_at,
    c2pa_details: c2pa ? {
      method: c2pa.verification_method,
      generator: c2pa.ai_generator,
      confidence: c2pa.confidence,
      c2pa_signed: c2pa.c2pa_signed,
      issuer: c2pa.c2pa_issuer,
      prompt_detected: !!c2pa.prompt,
    } : null,
  });
});

module.exports = router;
