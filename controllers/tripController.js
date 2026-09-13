const mongoose = require('mongoose');
const Trip = require('../models/Trip');

const buildSummary = (trip) => {
  const tripObj = typeof trip.toObject === 'function' ? trip.toObject() : trip;
  const members = tripObj.members || [];
  const n = members.length;
  const personPaid = new Array(n).fill(0);
  const personOwe = new Array(n).fill(0);
  let totalExpense = 0;

  members.forEach((member, payerIdx) => {
    (member.expenses || []).forEach((expense) => {
      const amt = Number(expense.amount) || 0;
      totalExpense += amt;
      personPaid[payerIdx] += amt;

      const splitAmong = expense.splitAmong && expense.splitAmong.length > 0
        ? expense.splitAmong
        : members.map((_, i) => i);

      const share = amt / splitAmong.length;
      splitAmong.forEach((i) => {
        if (i >= 0 && i < n) personOwe[i] += share;
      });
    });
  });

  const perPersonBalances = members.map((m, i) => ({
    name: m.name,
    spent: personPaid[i],
    balance: personPaid[i] - personOwe[i]
  }));

  const creditors = [];
  const debtors = [];
  perPersonBalances.forEach((p) => {
    if (p.balance > 0.005) creditors.push({ name: p.name, amount: p.balance });
    if (p.balance < -0.005) debtors.push({ name: p.name, amount: Math.abs(p.balance) });
  });

  const settlements = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const amt = Math.min(c.amount, d.amount);
    settlements.push({ from: d.name, to: c.name, amount: amt });
    c.amount -= amt;
    d.amount -= amt;
    if (Math.abs(c.amount) < 0.005) ci++;
    if (Math.abs(d.amount) < 0.005) di++;
  }

  return {
    totalExpense,
    personPaid,
    personOwe,
    personTotals: perPersonBalances.map((p) => ({ name: p.name, spent: p.spent })),
    equalShare: n > 0 ? totalExpense / n : 0,
    settlements,
    perPersonBalances
  };
};

exports.buildSummary = buildSummary;

exports.getOngoingTrips = async (req, res) => {
  try {
    const trips = await Trip.find({ isCompleted: false }).sort({ createdAt: -1 }).lean();
    res.json(trips);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getPastTrips = async (req, res) => {
  try {
    const trips = await Trip.find({ isCompleted: true })
      .sort({ completedDate: -1 })
      .limit(50)
      .lean();
    res.json(trips);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getTripById = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).lean();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    res.json(trip);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createTrip = async (req, res) => {
  try {
    const { destination, startDate, endDate, currency, memberCount, members } = req.body;

    if (!destination || !startDate || !endDate || !Array.isArray(members) || members.length < 2) {
      return res.status(400).json({ error: 'Missing or invalid required fields' });
    }

    const normalizedMembers = members.map((m) => ({
      name: (m.name || '').trim(),
      expenses: Array.isArray(m.expenses) ? m.expenses : []
    }));

    if (normalizedMembers.some((m) => !m.name)) {
      return res.status(400).json({ error: 'All members must have a name' });
    }

    const trip = new Trip({
      destination,
      startDate,
      endDate,
      currency: currency || 'INR',
      memberCount: memberCount || normalizedMembers.length,
      members: normalizedMembers,
      isCompleted: false
    });

    await trip.save();
    res.status(201).json(trip);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: err.message });
  }
};

exports.updateTrip = async (req, res) => {
  try {
    const { destination, startDate, endDate, currency, memberCount, members } = req.body;
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.isCompleted) return res.status(400).json({ error: 'Cannot edit a completed trip' });

    if (destination !== undefined) trip.destination = destination;
    if (startDate !== undefined) trip.startDate = startDate;
    if (endDate !== undefined) trip.endDate = endDate;
    if (currency !== undefined) trip.currency = currency;
    if (memberCount !== undefined) trip.memberCount = memberCount;

    if (Array.isArray(members)) {
      const oldMembers = trip.members;
      trip.members = members.map((m, i) => ({
        name: (m.name || '').trim() || oldMembers[i]?.name || '',
        expenses: Array.isArray(m.expenses) ? m.expenses : (oldMembers[i]?.expenses || [])
      }));
    }

    await trip.save();
    res.json(trip);
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: err.message });
  }
};

exports.deleteTrip = async (req, res) => {
  try {
    const trip = await Trip.findByIdAndDelete(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    res.json({ message: 'Trip deleted successfully', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.addExpense = async (req, res) => {
  try {
    const { memberIndex, amount, description, splitAmong } = req.body;
    if (memberIndex === undefined || amount === undefined || !description) {
      return res.status(400).json({ error: 'memberIndex, amount and description are required' });
    }

    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.isCompleted) return res.status(400).json({ error: 'Cannot add expense to completed trip' });
    if (!trip.members[memberIndex]) return res.status(400).json({ error: 'Invalid member index' });

    const expense = {
      amount: Number(amount),
      description: String(description).trim(),
      splitAmong: Array.isArray(splitAmong) && splitAmong.length > 0
        ? splitAmong.map(Number)
        : trip.members.map((_, i) => i)
    };

    trip.members[memberIndex].expenses.push(expense);
    await trip.save();

    const saved = trip.members[memberIndex].expenses[trip.members[memberIndex].expenses.length - 1];
    res.status(201).json({
      message: 'Expense added',
      expense: saved,
      memberIndex,
      tripId: trip._id
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: err.message });
  }
};

exports.updateExpense = async (req, res) => {
  try {
    const { memberIndex, expenseIndex, amount, description, splitAmong } = req.body;
    if (memberIndex === undefined || expenseIndex === undefined) {
      return res.status(400).json({ error: 'memberIndex and expenseIndex are required' });
    }

    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.isCompleted) return res.status(400).json({ error: 'Cannot edit completed trip' });

    const member = trip.members[memberIndex];
    if (!member) return res.status(400).json({ error: 'Invalid member index' });

    const expense = member.expenses[expenseIndex];
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    if (amount !== undefined) expense.amount = Number(amount);
    if (description !== undefined) expense.description = String(description).trim();
    if (splitAmong !== undefined) {
      expense.splitAmong = Array.isArray(splitAmong) && splitAmong.length > 0
        ? splitAmong.map(Number)
        : trip.members.map((_, i) => i);
    }

    await trip.save();
    res.json({ message: 'Expense updated', expense });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const { memberIndex, expenseIndex } = req.body;
    if (memberIndex === undefined || expenseIndex === undefined) {
      return res.status(400).json({ error: 'memberIndex and expenseIndex are required' });
    }

    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.isCompleted) return res.status(400).json({ error: 'Cannot edit completed trip' });

    const member = trip.members[memberIndex];
    if (!member) return res.status(400).json({ error: 'Invalid member index' });

    const removed = member.expenses.splice(expenseIndex, 1);
    if (removed.length === 0) return res.status(404).json({ error: 'Expense not found' });

    await trip.save();
    res.json({ message: 'Expense deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.completeTrip = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    trip.isCompleted = true;
    trip.completedDate = new Date();
    trip.summary = buildSummary(trip);

    await trip.save();
    res.json({ message: 'Trip completed', summary: trip.summary, trip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getSummary = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).lean();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const summary = buildSummary(trip);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.healthCheck = async (req, res) => {
  try {
    const state = mongoose.connection.readyState;
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const ongoingCount = await Trip.countDocuments({ isCompleted: false });
    const pastCount = await Trip.countDocuments({ isCompleted: true });

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      mongodb: states[state] || 'unknown',
      stats: {
        ongoingTrips: ongoingCount,
        pastTrips: pastCount
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
};
