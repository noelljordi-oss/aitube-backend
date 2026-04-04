// middleware/c2pa_verify.js
// ─────────────────────────────────────────────────────────────
// Niveau Argent : Vérification C2PA (Coalition for Content
// Provenance and Authenticity)
//
// C2PA est le standard industriel signé par Adobe, Microsoft,
// OpenAI, Google, Sony. Les fichiers générés par Dall-E 3,
// Midjourney v6+, Adobe Firefly, Stable Diffusion XL embarquent
// une signature cryptographique dans leurs métadonnées.
//
// Ce module :
//  1. Tente une vérification C2PA native (c2pa-node)
//  2. Si pas dispo → fallback sur analyse EXIF/XMP des métadonnées
//  3. Pour audio → analyse ID3/Vorbis tags via music-metadata
//  4. Pour vidéo → analyse des metadata streams via ffprobe
//  5. Retourne un objet VerificationResult standardisé
// ─────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');

// ── Known AI generator signatures ────────────────────────────
// Ces chaînes apparaissent dans les métadonnées C2PA / EXIF / ID3
// des fichiers générés par les principaux modèles IA.
const AI_GENERATOR_SIGNATURES = [
  // C2PA claim_generator champs
  'dall-e', 'dalle', 'openai',
  'midjourney', 'niji',
  'stable-diffusion', 'stable diffusion', 'stablediffusion',
  'sdxl', 'sdxl-turbo',
  'adobe firefly', 'firefly',
  'runway', 'runwayml', 'gen-2', 'gen-3',
  'pika', 'pikalabs',
  'kling', 'kuaishou',
  'suno', 'suno-ai', 'suno.ai',
  'udio', 'udio.com',
  'musicgen', 'audiocraft', 'meta audiocraft',
  'stable audio', 'stability ai',
  'elevenlabs',
  'sora', 'sora-v',
  'leonardo.ai', 'leonardo ai',
  'ideogram',
  'playground ai',
  'flux', 'flux.1',
  'imagen', 'google imagen',
  'aitube', // contenus re-générés sur la plateforme
  // EXIF Software field
  'neural', 'diffusion', 'generative', 'ai-generated',
  'ai_generated', 'machine learning', 'gan',
];

// ── Trusted C2PA certificate issuers ─────────────────────────
const TRUSTED_C2PA_ISSUERS = [
  'Adobe', 'Microsoft', 'OpenAI', 'Google', 'Sony',
  'Leica', 'Nikon', 'Canon', // caméras avec C2PA hardware
  'Truepic', 'Digimarc',
  'AiTube', // notre propre CA pour agents certifiés
];

// ─────────────────────────────────────────────────────────────
//  RÉSULTAT TYPE
// ─────────────────────────────────────────────────────────────
function makeResult(isAI, level, method, details = {}) {
  return {
    is_ai_generated: isAI,
    verification_level: level,          // 'silver' | 'bronze' | 'failed' | 'unknown'
    verification_method: method,        // 'c2pa' | 'exif' | 'audio_tags' | 'video_meta' | 'heuristic'
    confidence: details.confidence ?? (isAI ? 0.95 : 0.0),
    ai_generator: details.generator ?? null,
    ai_model:     details.model ?? null,
    c2pa_issuer:  details.issuer ?? null,
    c2pa_signed:  details.c2pa_signed ?? false,
    prompt:       details.prompt ?? null,
    generated_at: details.generated_at ?? null,
    raw:          details.raw ?? null,
    error:        details.error ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
//  1. VÉRIFICATION C2PA NATIVE (images)
// ─────────────────────────────────────────────────────────────
async function verifyC2PA(filePath, mimeType) {
  try {
    // c2pa-node peut ne pas être dispo sur tous les systèmes
    // (nécessite des bindings natifs Rust). On tente dynamiquement.
    const { createC2pa } = require('c2pa-node');
    const c2pa = createC2pa();

    const fileBuffer = fs.readFileSync(filePath);
    const result = await c2pa.read({ buffer: fileBuffer, mimeType });

    if (!result || !result.active_manifest) {
      return null; // Pas de manifeste C2PA → passer au fallback
    }

    const manifest = result.active_manifest;
    const generator = manifest.claim_generator ?? '';
    const assertions = manifest.assertions ?? [];

    // Chercher l'assertion "c2pa.ai.generated"
    const aiAssertion = assertions.find(a =>
      a.label === 'c2pa.ai.generatedContent' ||
      a.label === 'com.openai.content.credentials' ||
      a.label === 'adobe.ai.generated'
    );

    // Chercher le prompt dans les assertions
    let prompt = null;
    const promptAssertion = assertions.find(a =>
      a.label?.includes('prompt') || a.label?.includes('creative')
    );
    if (promptAssertion?.data?.prompt) prompt = promptAssertion.data.prompt;

    // Vérifier l'émetteur du certificat
    const sigInfo = manifest.signature_info ?? {};
    const issuer = sigInfo.issuer ?? '';
    const isTrustedIssuer = TRUSTED_C2PA_ISSUERS.some(t =>
      issuer.toLowerCase().includes(t.toLowerCase())
    );

    // Détecter le générateur IA dans claim_generator
    const genLower = generator.toLowerCase();
    const matchedSig = AI_GENERATOR_SIGNATURES.find(s => genLower.includes(s));

    const isAI = !!(aiAssertion || matchedSig);

    if (isAI) {
      return makeResult(true, 'silver', 'c2pa', {
        generator: matchedSig ?? generator,
        model: manifest.label ?? generator,
        issuer: isTrustedIssuer ? issuer : null,
        c2pa_signed: true,
        prompt,
        generated_at: sigInfo.time ?? null,
        confidence: isTrustedIssuer ? 0.99 : 0.92,
        raw: { manifest_label: manifest.label, assertions_count: assertions.length }
      });
    }

    // Manifeste C2PA présent mais pas de signature IA → contenu humain signé
    return makeResult(false, 'failed', 'c2pa', {
      error: 'C2PA manifest found but no AI generation assertion detected',
      c2pa_signed: true,
      issuer
    });

  } catch (err) {
    // c2pa-node non disponible ou fichier non supporté → fallback
    if (err.code === 'MODULE_NOT_FOUND') return null;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  2. FALLBACK EXIF / XMP (images)
// ─────────────────────────────────────────────────────────────
async function verifyImageExif(filePath) {
  try {
    const exifr = require('exifr');
    const exif = await exifr.parse(filePath, {
      xmp: true, iptc: true, icc: false,
      tiff: true, exif: true,
      mergeOutput: true,
    });

    if (!exif) return makeResult(false, 'unknown', 'exif', {
      error: 'No EXIF metadata found'
    });

    // Champs à inspecter
    const candidates = [
      exif.Software,
      exif.Creator,
      exif.Artist,
      exif.ImageDescription,
      exif.UserComment,
      exif.Comment,
      exif.XPComment,
      exif.Copyright,
      exif.dc_creator,
      exif.xmp_CreatorTool,
      exif.photoshop_Credit,
      exif.Iptc4xmpCore_CreatorContactInfo,
    ].filter(Boolean).map(v => String(v).toLowerCase());

    const allText = candidates.join(' ');
    const matchedSig = AI_GENERATOR_SIGNATURES.find(s => allText.includes(s));

    // Chercher un prompt dans les métadonnées XMP
    let prompt = null;
    const promptFields = [exif.UserComment, exif.ImageDescription, exif.Comment];
    for (const f of promptFields) {
      if (f && String(f).length > 20 && String(f).length < 1000) {
        prompt = String(f);
        break;
      }
    }

    if (matchedSig) {
      return makeResult(true, 'bronze', 'exif', {
        generator: matchedSig,
        model: exif.Software ?? matchedSig,
        prompt,
        confidence: 0.82,
        raw: { software: exif.Software, creator: exif.Creator }
      });
    }

    // Heuristique : pas de données GPS (les images IA n'ont pas de géolocalisation)
    const hasGPS = !!(exif.latitude || exif.longitude || exif.GPSLatitude);
    const hasCamera = !!(exif.Make || exif.Model || exif.LensModel);

    if (!hasGPS && !hasCamera && exif.Software) {
      return makeResult(true, 'bronze', 'heuristic', {
        confidence: 0.65,
        generator: 'Unknown AI tool',
        raw: { no_gps: true, no_camera: true, software: exif.Software }
      });
    }

    return makeResult(false, 'failed', 'exif', {
      error: 'No AI generator signature found in EXIF',
      confidence: 0,
      raw: { has_gps: hasGPS, has_camera: hasCamera }
    });

  } catch (err) {
    return makeResult(false, 'unknown', 'exif', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
//  3. VÉRIFICATION AUDIO (MP3/WAV/FLAC)
// ─────────────────────────────────────────────────────────────
async function verifyAudioMeta(filePath) {
  try {
    const mm = require('music-metadata');
    const meta = await mm.parseFile(filePath, { duration: false });
    const tags = meta.common ?? {};
    const native = meta.native ?? {};

    // Assembler tous les champs texte
    const candidates = [
      tags.artist,
      tags.albumartist,
      tags.album,
      tags.comment?.map(c => c.text).join(' '),
      tags.copyright,
      tags.encodedby,
      tags.tool,
      tags.description?.join(' '),
      // Tags natifs ID3
      ...(native['ID3v2.3'] ?? []).filter(t =>
        ['TENC','TSSE','COMM','TXXX','TPUB'].includes(t.id)
      ).map(t => t.value),
      // Tags Vorbis (FLAC/OGG)
      ...(native['vorbis'] ?? []).map(t => t.value),
    ].filter(Boolean).map(v => String(v).toLowerCase());

    const allText = candidates.join(' ');
    const matchedSig = AI_GENERATOR_SIGNATURES.find(s => allText.includes(s));

    // Prompt souvent stocké dans COMMENT ou TXXX:prompt
    let prompt = null;
    const txxx = (native['ID3v2.3'] ?? []).find(t =>
      t.id === 'TXXX' && t.value?.toLowerCase?.().includes('prompt')
    );
    if (txxx) prompt = txxx.value;
    else if (tags.comment?.[0]?.text?.length > 20) prompt = tags.comment[0].text;

    if (matchedSig) {
      return makeResult(true, 'silver', 'audio_tags', {
        generator: matchedSig,
        model: tags.encodedby ?? tags.tool ?? matchedSig,
        prompt,
        confidence: 0.90,
        raw: { artist: tags.artist, encodedby: tags.encodedby }
      });
    }

    // Heuristique audio : durée typique des générations IA (30s–10min)
    const dur = meta.format?.duration ?? 0;
    const isTypicalAIDuration = dur > 10 && dur < 600;
    const hasNoStandardTags = !tags.artist && !tags.album;

    if (isTypicalAIDuration && hasNoStandardTags) {
      return makeResult(true, 'bronze', 'heuristic', {
        confidence: 0.60,
        generator: 'Unknown AI music tool',
        raw: { duration: dur, no_standard_tags: true }
      });
    }

    return makeResult(false, 'failed', 'audio_tags', {
      error: 'No AI generator signature found in audio metadata'
    });

  } catch (err) {
    return makeResult(false, 'unknown', 'audio_tags', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
//  4. VÉRIFICATION VIDÉO (MP4/WEBM/MOV)
// ─────────────────────────────────────────────────────────────
async function verifyVideoMeta(filePath) {
  return new Promise((resolve) => {
    try {
      const ffmpeg = require('fluent-ffmpeg');

      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          resolve(makeResult(false, 'unknown', 'video_meta', { error: err.message }));
          return;
        }

        const fmt = metadata.format ?? {};
        const tags = fmt.tags ?? {};
        const streams = metadata.streams ?? [];

        // Assembler tous les champs texte du conteneur
        const candidates = [
          tags.encoder, tags.handler_name,
          tags.description, tags.comment,
          tags.artist, tags.title, tags.software,
          tags.creation_tool,
          ...streams.map(s => s.tags?.handler_name).filter(Boolean),
          ...streams.map(s => s.tags?.encoder).filter(Boolean),
        ].filter(Boolean).map(v => String(v).toLowerCase());

        const allText = candidates.join(' ');
        const matchedSig = AI_GENERATOR_SIGNATURES.find(s => allText.includes(s));

        let prompt = null;
        if (tags.description?.length > 20) prompt = tags.description;
        else if (tags.comment?.length > 20) prompt = tags.comment;

        if (matchedSig) {
          resolve(makeResult(true, 'silver', 'video_meta', {
            generator: matchedSig,
            model: tags.encoder ?? tags.software ?? matchedSig,
            prompt,
            confidence: 0.88,
            raw: { encoder: tags.encoder, format: fmt.format_long_name }
          }));
          return;
        }

        // Heuristique vidéo IA : codec H264/VP9, pas de audio PCM natif,
        // résolutions typiques IA (512, 768, 1024, 1280)
        const videoStream = streams.find(s => s.codec_type === 'video');
        const width = videoStream?.width ?? 0;
        const AI_WIDTHS = [512, 576, 640, 768, 832, 896, 1024, 1280, 1440, 1920];
        const isAIResolution = AI_WIDTHS.includes(width);
        const dur = parseFloat(fmt.duration ?? 0);
        const isShortAI = dur > 2 && dur < 60; // Les vidéos IA sont souvent courtes

        if (isAIResolution && isShortAI) {
          resolve(makeResult(true, 'bronze', 'heuristic', {
            confidence: 0.65,
            generator: 'Unknown AI video model',
            raw: { width, duration: dur }
          }));
          return;
        }

        resolve(makeResult(false, 'failed', 'video_meta', {
          error: 'No AI signature found in video metadata'
        }));
      });

    } catch (err) {
      resolve(makeResult(false, 'unknown', 'video_meta', { error: err.message }));
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  POINT D'ENTRÉE PRINCIPAL
// ─────────────────────────────────────────────────────────────
async function verifyAIContent(filePath, mimeType) {
  const isImage = mimeType.startsWith('image/');
  const isAudio = mimeType.startsWith('audio/');
  const isVideo = mimeType.startsWith('video/');

  let result = null;

  if (isImage) {
    // Étape 1 : C2PA natif (niveau Argent)
    result = await verifyC2PA(filePath, mimeType);

    // Étape 2 : Fallback EXIF si pas de C2PA
    if (!result) {
      result = await verifyImageExif(filePath);
    }
  }

  else if (isAudio) {
    // C2PA pour audio (spec 2.1+) puis fallback ID3
    result = await verifyC2PA(filePath, mimeType);
    if (!result) {
      result = await verifyAudioMeta(filePath);
    }
  }

  else if (isVideo) {
    result = await verifyC2PA(filePath, mimeType);
    if (!result) {
      result = await verifyVideoMeta(filePath);
    }
  }

  // Fallback ultime si aucune méthode n'a retourné de résultat
  if (!result) {
    result = makeResult(false, 'unknown', 'none', {
      error: 'Unsupported file type or verification failed'
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
//  MIDDLEWARE EXPRESS
// ─────────────────────────────────────────────────────────────
function c2paVerifyMiddleware(options = {}) {
  const {
    rejectHuman = true,       // Rejeter les contenus non-IA
    requireSilver = false,    // Exiger niveau Silver (C2PA natif)
    allowBronze = true,       // Accepter le niveau Bronze (EXIF/heuristique)
  } = options;

  return async (req, res, next) => {
    // Pas de fichier → skip
    if (!req.file) return next();

    const filePath = req.file.path;
    const mimeType = req.file.mimetype;

    console.log(`🔍 Vérification C2PA : ${req.file.originalname} (${mimeType})`);

    try {
      const result = await verifyAIContent(filePath, mimeType);

      // Attacher le résultat à la requête pour l'utiliser dans la route
      req.c2paResult = result;

      // Décision selon politique
      if (!result.is_ai_generated) {
        if (result.verification_level === 'unknown') {
          // Métadonnées absentes → on laisse passer avec avertissement
          console.warn(`⚠️  Vérification impossible pour ${req.file.originalname} — métadonnées absentes`);
          req.c2paResult.warning = 'Metadata unavailable — content accepted with lower trust';
          return next();
        }

        if (rejectHuman) {
          // Supprimer le fichier uploadé
          try { fs.unlinkSync(filePath); } catch (_) {}
          return res.status(422).json({
            error: 'Contenu refusé — aucune signature IA détectée',
            detail: 'AiTube accepte uniquement les contenus générés par des agents IA certifies. Ce fichier ne contient pas de signature C2PA ou de métadonnées de générateur IA reconnu.',
            verification: result,
            help: 'Pour publier sur AiTube, utilisez un modèle IA certifieé (Midjourney v6+, DALL-E 3, Stable Diffusion XL, Suno AI, Runway Gen-3...) et exportez le fichier directement depuis la plateforme.',
          });
        }
      }

      if (result.is_ai_generated && requireSilver && result.verification_level === 'bronze') {
        try { fs.unlinkSync(filePath); } catch (_) {}
        return res.status(422).json({
          error: 'Niveau de certification insuffisant',
          detail: 'Ce canal requiert une certification Argent (signature C2PA native). Votre fichier ne contient que des métadonnées EXIF/ID3.',
          verification: result,
        });
      }

      console.log(`✅ Vérification OK : ${result.verification_level} — ${result.ai_generator ?? 'IA détectée'} (confiance: ${(result.confidence * 100).toFixed(0)}%)`);
      next();

    } catch (err) {
      console.error('❌ Erreur vérification C2PA :', err.message);
      // En cas d'erreur système, on laisse passer (fail-open) avec log
      req.c2paResult = makeResult(false, 'unknown', 'error', { error: err.message });
      next();
    }
  };
}

module.exports = {
  verifyAIContent,
  c2paVerifyMiddleware,
  // Exports pour tests unitaires
  verifyC2PA,
  verifyImageExif,
  verifyAudioMeta,
  verifyVideoMeta,
  AI_GENERATOR_SIGNATURES,
};
