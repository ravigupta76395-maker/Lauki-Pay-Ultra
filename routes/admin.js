const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const Settings = require('../models/Settings');

// Admin Auth Middleware
const adminAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Login karo' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Admin only' });
    req.admin = user;
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
  }
};

// Dashboard Stats
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({ isAdmin: false });
    const totalWithdrawals = await Withdrawal.aggregate([
      { $match: { status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
    const todayUsers = await User.countDocuments({
      createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) },
      isAdmin: false
    });

    res.json({
      success: true,
      stats: {
        totalUsers,
        todayUsers,
        totalWithdrawn: totalWithdrawals[0]?.total || 0,
        pendingWithdrawals
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// All Users
router.get('/users', adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const query = { isAdmin: false };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search } },
        { referCode: { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);

    res.json({ success: true, users, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Block/Unblock User
router.post('/toggle-block/:userId', adminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user || user.isAdmin) return res.status(404).json({ success: false, message: 'User nahi mila' });
    
    user.isBlocked = !user.isBlocked;
    await user.save();

    res.json({ 
      success: true, 
      message: user.isBlocked ? 'User block ho gaya' : 'User unblock ho gaya',
      isBlocked: user.isBlocked
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add/Deduct Balance
router.post('/adjust-balance/:userId', adminAuth, async (req, res) => {
  try {
    const { amount, type, note } = req.body; // type: 'credit' or 'debit'
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });

    if (type === 'credit') {
      user.balance += Number(amount);
      user.totalEarned += Number(amount);
    } else if (type === 'debit') {
      if (user.balance < amount) return res.status(400).json({ success: false, message: 'Balance kam hai' });
      user.balance -= Number(amount);
    }

    await user.save();

    await Transaction.create({
      userId: user._id,
      type: type === 'credit' ? 'admin_credit' : 'admin_debit',
      amount: type === 'credit' ? amount : -amount,
      description: note || `Admin ne ${type} kiya`,
      status: 'completed'
    });

    res.json({ success: true, message: 'Balance update ho gaya', balance: user.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update Settings
router.post('/settings', adminAuth, async (req, res) => {
  try {
    const { referBonus, dailyBonus, minWithdrawal, maxWithdrawal, withdrawalNumber, appName } = req.body;

    let settings = await Settings.findOne();
    if (!settings) settings = new Settings();

    if (referBonus !== undefined) settings.referBonus = referBonus;
    if (dailyBonus !== undefined) settings.dailyBonus = dailyBonus;
    if (minWithdrawal !== undefined) settings.minWithdrawal = minWithdrawal;
    if (maxWithdrawal !== undefined) settings.maxWithdrawal = maxWithdrawal;
    if (withdrawalNumber !== undefined) settings.withdrawalNumber = withdrawalNumber;
    if (appName !== undefined) settings.appName = appName;
    settings.updatedAt = new Date();

    await settings.save();
    res.json({ success: true, message: 'Settings update ho gayi', settings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get Settings
router.get('/settings', adminAuth, async (req, res) => {
  const settings = await Settings.findOne();
  res.json({ success: true, settings });
});

// All Withdrawals
router.get('/withdrawals', adminAuth, async (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const query = status ? { status } : {};

    const withdrawals = await Withdrawal.find(query)
      .populate('userId', 'name phone')
      .sort({ createdAt: -1 })
      .skip((page - 1) * 20)
      .limit(20);

    const total = await Withdrawal.countDocuments(query);
    res.json({ success: true, withdrawals, total });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update Withdrawal Status
router.post('/withdrawal-status/:id', adminAuth, async (req, res) => {
  try {
    const { status, note } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id).populate('userId');

    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal nahi mila' });

    // Agar fail karo to balance wapas do
    if (status === 'failed' && withdrawal.status !== 'failed') {
      withdrawal.userId.balance += withdrawal.amount;
      await withdrawal.userId.save();
    }

    withdrawal.status = status;
    withdrawal.adminNote = note;
    withdrawal.updatedAt = new Date();
    await withdrawal.save();

    res.json({ success: true, message: 'Status update ho gaya' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Broadcast bonus to all users (24hr type)
router.post('/broadcast-bonus', adminAuth, async (req, res) => {
  try {
    const { amount, description } = req.body;
    
    const users = await User.find({ isAdmin: false, isBlocked: false });
    
    let count = 0;
    for (const user of users) {
      user.balance += Number(amount);
      user.totalEarned += Number(amount);
      await user.save();
      
      await Transaction.create({
        userId: user._id,
        type: 'admin_credit',
        amount: Number(amount),
        description: description || 'Admin Special Bonus',
        status: 'completed'
      });
      count++;
    }

    res.json({ success: true, message: `${count} users ko ₹${amount} bonus diya gaya` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
