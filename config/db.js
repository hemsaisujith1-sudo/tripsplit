const mongoose = require('mongoose');
require('dotenv').config();

async function connectDB() {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not set in .env file. Please add your MongoDB connection string.');
    }

    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000
    });

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    console.log(`   Database: ${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error('❌ MongoDB connection FAILED:');
    console.error('   ', error.message);
    console.error('\n💡 Troubleshooting tips:');
    console.error('   1. Verify your .env file has MONGODB_URI set correctly');
    console.error('   2. In MongoDB Atlas, go to Network Access → Add 0.0.0.0/0 (allow all IPs temporarily)');
    console.error('   3. Ensure your database username/password in the URI are correct');
    console.error('   4. If password was shared publicly, ROTATE IT immediately in Atlas → Security → Database Access');
    process.exit(1);
  }
}

module.exports = connectDB;
