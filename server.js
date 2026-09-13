require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');

let dbState = 'idle';
let dbConnectPromise = null;
let lastError = null;
const FAIL_COOLDOWN_MS = 15000;
let lastFailAt = 0;

async function ensureDB(options = {}) {
  const { exitOnError = false } = options;
  const now = Date.now();

  if (dbState === 'connected') return;

  if (dbState === 'failed' && (now - lastFailAt) < FAIL_COOLDOWN_MS) {
    throw lastError || new Error('Database connection recently failed; try again shortly.');
  }

  if (dbState === 'connecting' && dbConnectPromise) {
    return dbConnectPromise;
  }

  dbState = 'connecting';
  dbConnectPromise = (async () => {
    try {
      await connectDB({ exitOnError });
      dbState = 'connected';
      lastError = null;
    } catch (err) {
      dbState = 'failed';
      lastFailAt = Date.now();
      lastError = err;
      dbConnectPromise = null;
      throw err;
    }
  })();

  return dbConnectPromise;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || true)
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(async (req, res, next) => {
  try {
    await ensureDB();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database connection failed', detail: err.message });
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/api/trips', require('./routes/trips'));

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

const vercelHandler = async (req, res) => {
  try {
    await ensureDB();
  } catch (err) {
    return res.status(503).json({
      error: 'Database unavailable on deployment',
      hint: 'Set MONGODB_URI environment variable in Vercel Project Settings → Environment Variables',
      detail: process.env.MONGODB_URI ? err.message : 'MONGODB_URI env var is missing'
    });
  }
  return app(req, res);
};

vercelHandler.app = app;
vercelHandler.ensureDB = ensureDB;
vercelHandler.default = vercelHandler;
module.exports = vercelHandler;

if (require.main === module) {
  (async () => {
    try {
      console.log('\n🚀 TripSplit v2 — starting up...');
      console.log('   Mode: Full-stack (Express + MongoDB + static frontend)');
      await ensureDB({ exitOnError: true });
      app.listen(PORT, () => {
        console.log(`\n✅ Server ready → http://localhost:${PORT}`);
        console.log(`   API base    → http://localhost:${PORT}/api/trips`);
        console.log(`   Healthcheck → http://localhost:${PORT}/api/trips/health\n`);
      });
    } catch (e) {
      console.error('Failed to start server:', e);
      process.exit(1);
    }
  })();
}
