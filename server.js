require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || true)
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

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

const start = async () => {
  console.log('\n🚀 TripSplit v2 — starting up...');
  console.log('   Mode: Full-stack (Express + MongoDB + static frontend)');
  await connectDB();
  app.listen(PORT, () => {
    console.log(`\n✅ Server ready → http://localhost:${PORT}`);
    console.log(`   API base    → http://localhost:${PORT}/api/trips`);
    console.log(`   Healthcheck → http://localhost:${PORT}/api/trips/health\n`);
  });
};

start();
