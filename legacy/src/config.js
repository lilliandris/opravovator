const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  // Povolená doména e-mailov (registrácia aj Google login)
  ALLOWED_DOMAIN: (process.env.ALLOWED_DOMAIN || 'trojsten.sk').toLowerCase(),
  // Google OAuth Client ID (voliteľné). Bez neho sa Google tlačidlo nezobrazí.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  // Na HTTPS nastav COOKIE_SECURE=1
  COOKIE_SECURE: process.env.COOKIE_SECURE === '1',
  // Názov súboru s komentárom, ak v zipe žiadny nie je
  COMMENT_FILENAME: process.env.COMMENT_FILENAME || 'komentar.txt',
  POINTS_FILENAME: process.env.POINTS_FILENAME || 'body.txt',
  ORIGINAL_PREFIX: 'original-',
  SESSION_DAYS: 30,
  MAX_UPLOAD_MB: parseInt(process.env.MAX_UPLOAD_MB || '4096', 10),
};
