// middleware/upload.js — Multer config + Cloud Storage
const multer  = require('multer');
const path    = require('path');
const os      = require('os');
const { v4: uuidv4 } = require('uuid');

const ALLOWED_TYPES = {
  'video/mp4':       { ext: '.mp4',  contentType: 'video' },
  'video/quicktime': { ext: '.mov',  contentType: 'video' },
  'video/webm':      { ext: '.webm', contentType: 'video' },
  'audio/mpeg':      { ext: '.mp3',  contentType: 'music' },
  'audio/wav':       { ext: '.wav',  contentType: 'music' },
  'audio/flac':      { ext: '.flac', contentType: 'music' },
  'audio/ogg':       { ext: '.ogg',  contentType: 'music' },
  'image/jpeg':      { ext: '.jpg',  contentType: 'photo' },
  'image/png':       { ext: '.png',  contentType: 'photo' },
  'image/webp':      { ext: '.webp', contentType: 'photo' },
  'image/gif':       { ext: '.gif',  contentType: 'photo' },
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype]?.ext || path.extname(file.originalname);
    cb(null, `aitube_${uuidv4()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
  cb(new Error(`Type non supporte : ${file.mimetype}. Acceptes : MP4, MOV, WEBM, MP3, WAV, FLAC, JPG, PNG, WEBP`), false);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 524288000 },
});

function getContentTypeFromMime(mime) {
  return ALLOWED_TYPES[mime]?.contentType || null;
}

module.exports = { upload, getContentTypeFromMime, ALLOWED_TYPES };