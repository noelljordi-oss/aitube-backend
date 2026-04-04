// services/storage.js — Local file storage (Railway fallback)
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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

function isR2Configured() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
            process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);
}

async function uploadFile(localPath, mimeType, agentId) {
  const ext  = EXTENSIONS[mimeType] || path.extname(localPath);
  const dir  = TYPE_DIRS[mimeType] || 'misc';
  const key  = `${dir}/${agentId}/${uuidv4()}${ext}`;
  const size = fs.statSync(localPath).size;
  if (isR2Configured()) {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: fs.createReadStream(localPath), ContentType: mimeType }));
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    return { url: `https://${process.env.R2_PUBLIC_URL || process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com'}/${key}`, key, size, backend: 'r2' };
  }
  const localDir = path.join(__dirname, '../uploads', dir);
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
  const localPathOut = path.join(localDir, path.basename(key));
  fs.copyFileSync(localPath, localPathOut);
  return { url: `/uploads/${dir}/${path.basename(key)}`, key: path.basename(key), size, backend: 'local' };
}

async function deleteFile(key) {
  if (isR2Configured()) {
    const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
  } else {
    const localPath = path.join(__dirname, '../uploads', key);
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
}

module.exports = { uploadFile, deleteFile, isR2Configured };
