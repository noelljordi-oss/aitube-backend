// services/storage.js
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function isR2Configured() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
}

let s3Client = null;
function getS3Client() {
  if (s3Client) return s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
}

const TYPE_DIRS = {
  'video/mp4': 'videos', 'video/quicktime': 'videos', 'video/webm': 'videos',
  'audio/mpeg': 'music', 'audio/wav': 'music', 'audio/flac': 'music', 'audio/ogg': 'music',
  'image/jpeg': 'photos', 'image/png': 'photos', 'image/webp': 'photos', 'image/gif': 'photos',
};

const EXTENSIONS = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/flac': '.flac', 'audio/ogg': '.ogg',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
};

arync function uploadFile(localPath, mimeType, agentId) {
  const ext = EXTENSIONS[mimeType] || path.extname(localPath);
  const dir = TYPE_DIRS[mimeType] || 'misc';
  const key = `${dir}/${agentId}/${uuidv4()}${ext}`;
  const size = fs.statSync(localPath).size;
  if (isR2Configured()) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: fs.createReadStream(localPath), ContentType: mimeType,
      Metadata: {'agent-id': agentId, 'uploaded-at': new Date().toISOString()},
    }));
    try { fs.unlinkSync(localPath); } catch (_) {}
    const baseUrl = process.env.R2_PUBLIC_URL || `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.dev`;
    return { storage: 'r2', key, url: `${baseUrl}/${key}`, size };
  }
  const uploadDir = path.join(__dirname, '../uploads', dir);
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${uuidv4()}${ext}`;
  const destPath = path.join(uploadDir, filename);
  fs.renameSync(localPath, destPath);
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return { storage: 'local', key: `${dir}/${filename}`, url: `${baseUrl}/media/${dir}/${filename}`, size };
}

async function deleteFile(key, storage = 'r2') {
  if (storage === 'r2' && isR2Configured()) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    return true;
  }
  const localPath = path.join(__dirname, '../uploads', key);
  if (fs.existsSync(localPath)) { fs.unlinkSync(localPath); return true; }
  return false;
}

arync function getSignedUrl(key, expiresInSeconds = 3600) {
  if (!isR2Configured()) {
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    return `${baseUrl}/media/${key}`;
  }
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }), { expiresIn: expiresInSeconds });
}

function createMulterStorage() {
  const multer = require('multer');
  const os = require('os');
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const ext = EXTENSIONS[file.mimetype] || path.extname(file.originalname);
      cb(null, `aitube_${uuidv4()}${ext}`);
    },
  });
}

module.exports = { uploadFile, deleteFile, getSignedUrl, createMulterStorage, isR2Configured };
