const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ── Password hashing ──────────────────────────────────────────────────────────
function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}
function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

// ── API-key encryption at rest (AES-256-GCM) ──────────────────────────────────
// APP_SECRET must be a 64-char hex string (32 bytes). Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
function getKey() {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length !== 64) {
    throw new Error('APP_SECRET must be a 64-char hex string (32 bytes). See .env.example.');
  }
  return Buffer.from(secret, 'hex');
}

function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store iv:tag:ciphertext, all hex
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const [ivHex, tagHex, dataHex] = blob.split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// ── Route guard ───────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  // Real browser navigations explicitly prefer text/html → redirect to /login.
  // XHR/fetch (Accept: */*) resolve to 'json' here → get a 401 JSON body.
  if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html') {
    return res.redirect('/login');
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { hashPassword, verifyPassword, encrypt, decrypt, requireAuth };
