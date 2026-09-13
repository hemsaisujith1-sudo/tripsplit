const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: 2,
    maxlength: 80
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: 160
  },
  passwordHash: {
    type: String,
    required: true,
    select: false
  }
}, {
  collection: 'users',
  timestamps: true
});

module.exports = mongoose.model('User', userSchema);
