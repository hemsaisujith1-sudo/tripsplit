const mongoose = require('mongoose');
require('dotenv').config();

async function connectDB(options = {}) {
  const { exitOnError = false } = options;
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is missing. Add it to .env (local) or Vercel Project Settings → Environment Variables.');
    }

    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
      return mongoose;
    }

    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10
    });

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    console.log(`   Database: ${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error('❌ MongoDB connection FAILED:');
    console.error('   ', error.message);
    console.error('\n💡 Troubleshooting tips:');
    console.error('   1. Verify your MONGODB_URI env var has the correct connection string');
    console.error('   2. In MongoDB Atlas → Network Access → Add 0.0.0.0/0 (allow all IPs) OR add Vercel');
    console.error('      https://vercel.com/guides/how-to-allowlist-deployment-ip-addresses');
    console.error('   3. Ensure your database username/password in the URI are correct');
    console.error('   4. If password was shared publicly, ROTATE IT immediately in Atlas → Security → Database Access');

    if (exitOnError) {
      process.exit(1);
    }
    throw error;
  }
}

module.exports = connectDB;
