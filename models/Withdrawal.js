const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  method: { type: String, enum: ['upi', 'csv'], required: true },
  withdrawalNumber: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'success', 'failed'],
    default: 'pending' 
  },
  apiResponse: { type: Object, default: null },
  adminNote: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
