const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  referCode: { type: String, unique: true, uppercase: true },
  referredBy: { type: String, default: null },
  balance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  referCount: { type: Number, default: 0 },
  withdrawalNumber: { type: String, default: null },
  isAdmin: { type: Boolean, default: false },
  isBlocked: { type: Boolean, default: false },
  lastBonusClaim: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

// Auto generate refer code
userSchema.pre('save', function(next) {
  if (!this.referCode) {
    this.referCode = 'REF' + Math.random().toString(36).substr(2, 6).toUpperCase();
  }
  next();
});

module.exports = mongoose.model('User', userSchema);
