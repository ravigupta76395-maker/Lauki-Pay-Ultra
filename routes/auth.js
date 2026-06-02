const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, phone, password, referCode } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Sabhi fields bharo' });
    }

    const exists = await User.findOne({ phone });
    if (exists) {
      return res.status(400).json({ success: false, message: 'Phone already registered hai' });
    }

    const settings = await Settings.findOne();
    const referBonus = settings ? settings.referBonus : 2;

    const user = new User({ name, phone, password });

    // Refer code check
    if (referCode) {
      const referrer = await User.findOne({ referCode: referCode.toUpperCase() });
      if (referrer && referrer.phone !== phone) {
        user.referredBy = referrer.phone;
        
        // Referrer ko bonus do
        referrer.balance += referBonus;
        referrer.totalEarned += referBonus;
        referrer.referCount += 1;
        await referrer.save();

        // Transaction record karo
        await Transaction.create({
          userId: referrer._id,
          type: 'refer_bonus',
          amount: referBonus,
          description: `${phone} ne aapka refer code use kiya`,
          referredUser: phone,
          status: 'completed'
        });
      }
    }

    await user.save();

    const token = jwt.sign({ id: user._id, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({ 
      success: true, 
      message: 'Registration successful!',
      token,
      user: { name: user.name, phone: user.phone, referCode: user.referCode, balance: user.balance, isAdmin: user.isAdmin }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    const user = await User.findOne({ phone });
    if (!user) return res.status(400).json({ success: false, message: 'Phone number galat hai' });
    if (user.isBlocked) return res.status(403).json({ success: false, message: 'Aapka account block hai' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Password galat hai' });

    const token = jwt.sign({ id: user._id, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({ 
      success: true, 
      token,
      user: { 
        name: user.name, phone: user.phone, 
        referCode: user.referCode, balance: user.balance,
        isAdmin: user.isAdmin, totalEarned: user.totalEarned,
        referCount: user.referCount
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
