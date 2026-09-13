const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  amount: {
    type: Number,
    required: true,
    min: [0, 'Expense amount cannot be negative']
  },
  description: {
    type: String,
    required: [true, 'Expense description is required'],
    trim: true
  },
  splitAmong: [{
    type: Number,
    required: true
  }]
}, {
  _id: true,
  timestamps: true
});

const memberSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Member name is required'],
    trim: true
  },
  expenses: [expenseSchema]
}, {
  _id: false
});

const summarySchema = new mongoose.Schema({
  totalExpense: Number,
  personPaid: [Number],
  personOwe: [Number],
  personTotals: [{ name: String, spent: Number }],
  equalShare: Number,
  settlements: [{ from: String, to: String, amount: Number }],
  perPersonBalances: [{ name: String, spent: Number, balance: Number }]
}, {
  _id: false
});

const tripSchema = new mongoose.Schema({
  destination: {
    type: String,
    required: [true, 'Trip destination is required'],
    trim: true
  },
  startDate: {
    type: String,
    required: [true, 'Trip start date is required']
  },
  endDate: {
    type: String,
    required: [true, 'Trip end date is required']
  },
  currency: {
    type: String,
    required: true,
    default: 'INR',
    enum: ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'SGD']
  },
  memberCount: {
    type: Number,
    required: true,
    min: 2,
    max: 20
  },
  members: {
    type: [memberSchema],
    required: true,
    validate: {
      validator: function(v) {
        return Array.isArray(v) && v.length >= 2;
      },
      message: 'A trip must have at least 2 members'
    }
  },
  isCompleted: {
    type: Boolean,
    default: false
  },
  completedDate: {
    type: Date
  },
  summary: summarySchema
}, {
  collection: 'trips',
  timestamps: true
});

tripSchema.index({ isCompleted: 1, createdAt: -1 });

tripSchema.pre('save', function(next) {
  if (this.isCompleted && !this.completedDate) {
    this.completedDate = new Date();
  }
  next();
});

module.exports = mongoose.model('Trip', tripSchema);
