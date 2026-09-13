const express = require('express');
const router = express.Router();
const c = require('../controllers/tripController');

// ---- Health ----
router.get('/health', c.healthCheck);

// ---- Trip lists ----
router.get('/ongoing', c.getOngoingTrips);
router.get('/past', c.getPastTrips);

// ---- Single trip CRUD ----
router.get('/:id', c.getTripById);
router.post('/', c.createTrip);
router.put('/:id', c.updateTrip);
router.delete('/:id', c.deleteTrip);

// ---- Complete / Summary ----
router.post('/:id/complete', c.completeTrip);
router.get('/:id/summary', c.getSummary);

// ---- Expenses (nested) ----
router.post('/:id/expenses', c.addExpense);
router.put('/:id/expenses', c.updateExpense);
router.delete('/:id/expenses', c.deleteExpense);

module.exports = router;
