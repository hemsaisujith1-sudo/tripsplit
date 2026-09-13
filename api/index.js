const { app, ensureDB } = require('../server');

module.exports = async (req, res) => {
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
