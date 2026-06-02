// Withdraw Request
router.post('/withdraw', auth, async (req, res) => {
  try {
    const { amount, method } = req.body;
    const settings = await Settings.findOne();

    if (!req.user.withdrawalNumber) {
      return res.status(400).json({ success: false, message: 'Pehle withdrawal number set karo' });
    }

    if (!amount || amount < settings.minWithdrawal) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal ₹${settings.minWithdrawal} hai` });
    }

    if (amount > settings.maxWithdrawal) {
      return res.status(400).json({ success: false, message: `Maximum withdrawal ₹${settings.maxWithdrawal} hai` });
    }

    if (req.user.balance < amount) {
      return res.status(400).json({ success: false, message: 'Balance kam hai' });
    }

    // Balance deduct karo
    req.user.balance -= amount;
    await req.user.save();

    const withdrawal = await Withdrawal.create({
      userId: req.user._id,
      amount,
      method: method || 'upi',
      withdrawalNumber: req.user.withdrawalNumber,
      status: 'processing'
    });

    // ===== ULTRA PAY API (UPI) =====
    if (method === 'upi' || method === 'ultra') {
      try {
        const url = `https://ultra-pay.store/APIs/api` +
          `?token=${process.env.ULTRA_TOKEN}` +
          `&key=${process.env.ULTRA_KEY}` +
          `&paytoNumber=${req.user.withdrawalNumber}` +
          `&amount=${amount}` +
          `&comment=Withdrawal`;

        const apiRes = await axios.get(url, { timeout: 15000 });

        console.log('Ultra API Response:', apiRes.data);

        // Success check
        if (apiRes.data && (apiRes.data.status === 'success' || apiRes.data.status === true || apiRes.data.success === true || apiRes.status === 200)) {
          withdrawal.status = 'success';
          withdrawal.apiResponse = apiRes.data;
          await withdrawal.save();

          await Transaction.create({
            userId: req.user._id,
            type: 'withdrawal',
            amount: -amount,
            description: `UPI (Ultra) Withdrawal to ${req.user.withdrawalNumber}`,
            status: 'completed'
          });

          return res.json({ success: true, message: `✅ ₹${amount} UPI pe send ho gaya!` });
        } else {
          throw new Error(apiRes.data?.message || 'Ultra API failed');
        }

      } catch (apiErr) {
        console.error('Ultra API Error:', apiErr.message);
        // Balance wapas do
        req.user.balance += amount;
        await req.user.save();
        withdrawal.status = 'failed';
        withdrawal.apiResponse = { error: apiErr.message };
        await withdrawal.save();
        return res.status(500).json({ success: false, message: `UPI API error: ${apiErr.message}` });
      }
    }

    // ===== VSV GATEWAY API =====
    if (method === 'csv' || method === 'vsv') {
      try {
        const url = `https://vsv-gateway-solutions.co.in/Api/api.php` +
          `?token=${process.env.VSV_TOKEN}` +
          `&paytm=${req.user.withdrawalNumber}` +
          `&amount=${amount}` +
          `&comment=Payment`;

        const apiRes = await axios.get(url, { timeout: 15000 });

        console.log('VSV API Response:', apiRes.data);

        if (apiRes.data && (apiRes.data.status === 'success' || apiRes.data.status === true || apiRes.data.success === true || apiRes.status === 200)) {
          withdrawal.status = 'success';
          withdrawal.apiResponse = apiRes.data;
          await withdrawal.save();

          await Transaction.create({
            userId: req.user._id,
            type: 'withdrawal',
            amount: -amount,
            description: `VSV Withdrawal to ${req.user.withdrawalNumber}`,
            status: 'completed'
          });

          return res.json({ success: true, message: `✅ ₹${amount} VSV se transfer ho gaya!` });
        } else {
          throw new Error(apiRes.data?.message || 'VSV API failed');
        }

      } catch (apiErr) {
        console.error('VSV API Error:', apiErr.message);
        req.user.balance += amount;
        await req.user.save();
        withdrawal.status = 'failed';
        withdrawal.apiResponse = { error: apiErr.message };
        await withdrawal.save();
        return res.status(500).json({ success: false, message: `VSV API error: ${apiErr.message}` });
      }
    }

    // Default: manual pending
    res.json({ success: true, message: 'Withdrawal request send ho gayi', withdrawalId: withdrawal._id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
