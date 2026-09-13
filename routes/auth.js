const crypto = require('crypto');
const express = require('express');
const User = require('../models/User');

const router = express.Router();
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const AUTH_SECRET = process.env.AUTH_SECRET || 'tripsplit-development-secret-change-me';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash || '').split(':');
  if (!salt || !expected) return false;
  const actual = hashPassword(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function signToken(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: String(user._id),
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function verifyToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return data.exp > Math.floor(Date.now() / 1000) ? data : null;
}

function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email };
}

async function requireUser(req, res, next) {
  try {
    const tokenData = verifyToken(readToken(req));
    if (!tokenData) return res.status(401).json({ error: 'Please log in to continue' });
    const user = await User.findById(tokenData.sub).lean();
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid authentication token' });
  }
}

router.post('/signup', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (name.length < 2) return res.status(400).json({ error: 'Enter your full name' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (await User.exists({ email })) return res.status(409).json({ error: 'An account with that email already exists' });

    const user = await User.create({ name, email, passwordHash: hashPassword(password) });
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to create account' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to log in right now' });
  }
});

router.get('/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = { router, requireUser };
