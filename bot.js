const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
require('dotenv').config();

// MongoDB Connect
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

const User = require('./models/User');
const Transaction = require('./models/Transaction');
const Withdrawal = require('./models/Withdrawal');
const Settings = require('./models/Settings');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// User sessions store karo
const sessions = {}; // { chatId: { step, data } }

console.log('🤖 Bot chal raha hai...');

// ===== /start COMMAND =====
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param = match[1].trim(); // refer code agar link se aaya

  sessions[chatId] = { referCode: param || null };

  const existingUser = await User.findOne({ telegramId: String(chatId) });

  if (existingUser) {
    return showMainMenu(chatId, existingUser);
  }

  await bot.sendMessage(chatId,
    `🎉 *ReferEarn Bot mein Aapka Swagat Hai!*\n\n` +
    `💰 Refer karo aur paise kamaao!\n` +
    `📱 Har refer pe ₹2-3 milega\n` +
    `⚡ Daily bonus bhi milega!\n\n` +
    `_Pehle apna naam daalo:_`,
    { parse_mode: 'Markdown' }
  );

  sessions[chatId] = { ...sessions[chatId], step: 'get_name' };
});

// ===== MESSAGE HANDLER =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  const session = sessions[chatId] || {};

  // Registration flow
  if (session.step === 'get_name') {
    sessions[chatId] = { ...session, step: 'get_phone', name: text.trim() };
    return bot.sendMessage(chatId, `👍 *${text}*!\n\nAb apna *phone number* daalo (10 digit):`, { parse_mode: 'Markdown' });
  }

  if (session.step === 'get_phone') {
    const phone = text.trim().replace(/\D/g, '');
    if (phone.length !== 10) {
      return bot.sendMessage(chatId, '❌ 10 digit ka phone number daalo!');
    }

    const exists = await User.findOne({ phone });
    if (exists) {
      return bot.sendMessage(chatId, '❌ Ye phone number already registered hai!\n\n/start karke fir try karo ya /login likho');
    }

    sessions[chatId] = { ...session, step: 'get_password', phone };
    return bot.sendMessage(chatId, `📱 Phone: *${phone}*\n\nAb ek *password* set karo:`, { parse_mode: 'Markdown' });
  }

  if (session.step === 'get_password') {
    const password = text.trim();
    if (password.length < 4) {
      return bot.sendMessage(chatId, '❌ Password kam se kam 4 characters ka hona chahiye!');
    }

    // Register karo
    try {
      const settings = await Settings.findOne();
      const referBonus = settings?.referBonus || 2;

      const user = new User({
        name: session.name,
        phone: session.phone,
        password: password,
        telegramId: String(chatId),
        telegramUsername: msg.from.username || null
      });

      // Refer code process karo
      if (session.referCode) {
        const referrer = await User.findOne({ referCode: session.referCode.toUpperCase() });
        if (referrer && referrer.phone !== session.phone) {
          user.referredBy = referrer.phone;

          referrer.balance += referBonus;
          referrer.totalEarned += referBonus;
          referrer.referCount += 1;
          await referrer.save();

          await Transaction.create({
            userId: referrer._id,
            type: 'refer_bonus',
            amount: referBonus,
            description: `${session.phone} ne join kiya`,
            referredUser: session.phone,
            status: 'completed'
          });

          // Referrer ko notify karo
          if (referrer.telegramId) {
            bot.sendMessage(referrer.telegramId,
              `🎉 *Refer Bonus Mila!*\n\n` +
              `👤 ${session.name} ne aapka refer code use kiya!\n` +
              `💰 +₹${referBonus} aapke account mein add hua!\n` +
              `💼 Naya Balance: ₹${referrer.balance.toFixed(2)}`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
        }
      }

      await user.save();

      sessions[chatId] = {};
      showMainMenu(chatId, user, `✅ *Registration Successful!*\n\nWelcome, *${user.name}*! 🎉\nAapka Refer Code: \`${user.referCode}\``);

    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, '❌ Registration mein error aaya. Dobara try karo.\n\n/start');
    }
    return;
  }

  // Withdrawal amount input
  if (session.step === 'withdraw_amount') {
    const amount = parseFloat(text);
    const settings = await Settings.findOne();

    if (!amount || amount <= 0) return bot.sendMessage(chatId, '❌ Valid amount daalo');
    if (amount < settings.minWithdrawal) return bot.sendMessage(chatId, `❌ Minimum withdrawal ₹${settings.minWithdrawal} hai`);
    if (amount > settings.maxWithdrawal) return bot.sendMessage(chatId, `❌ Maximum withdrawal ₹${settings.maxWithdrawal} hai`);

    const user = await User.findOne({ telegramId: String(chatId) });
    if (!user) return bot.sendMessage(chatId, '❌ /start karo pehle');
    if (user.balance < amount) return bot.sendMessage(chatId, `❌ Balance kam hai!\nAapka balance: ₹${user.balance.toFixed(2)}`);

    sessions[chatId] = { ...session, step: 'withdraw_method', amount };

    return bot.sendMessage(chatId, `💸 *Withdrawal: ₹${amount}*\n\nWithdrawal method chuniye:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📱 UPI (Ultra)', callback_data: 'wd_upi' },
            { text: '🏦 CSV Transfer', callback_data: 'wd_csv' }
          ],
          [{ text: '❌ Cancel', callback_data: 'wd_cancel' }]
        ]
      }
    });
  }

  // Set withdrawal number
  if (session.step === 'set_wd_number') {
    const number = text.trim();
    if (number.length < 5) return bot.sendMessage(chatId, '❌ Valid UPI ID ya account number daalo');

    const user = await User.findOne({ telegramId: String(chatId) });
    if (!user) return bot.sendMessage(chatId, '❌ /start karo');

    user.withdrawalNumber = number;
    await user.save();
    sessions[chatId] = {};

    return bot.sendMessage(chatId, `✅ *Withdrawal Number Set Ho Gaya!*\n\n📱 Number: \`${number}\``, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'menu_home' }]]
      }
    });
  }

  // Admin: set refer bonus
  if (session.step === 'admin_set_refer') {
    const val = parseFloat(text);
    if (!val || val <= 0) return bot.sendMessage(chatId, '❌ Valid amount daalo');
    let s = await Settings.findOne();
    if (!s) s = new Settings();
    s.referBonus = val;
    await s.save();
    sessions[chatId] = {};
    return bot.sendMessage(chatId, `✅ Refer bonus set ho gaya: ₹${val}`, {
      reply_markup: { inline_keyboard: [[{ text: '⚙️ Admin Panel', callback_data: 'admin_panel' }]] }
    });
  }

  if (session.step === 'admin_set_daily') {
    const val = parseFloat(text);
    if (!val || val <= 0) return bot.sendMessage(chatId, '❌ Valid amount daalo');
    let s = await Settings.findOne();
    if (!s) s = new Settings();
    s.dailyBonus = val;
    await s.save();
    sessions[chatId] = {};
    return bot.sendMessage(chatId, `✅ Daily bonus set ho gaya: ₹${val}`, {
      reply_markup: { inline_keyboard: [[{ text: '⚙️ Admin Panel', callback_data: 'admin_panel' }]] }
    });
  }

  if (session.step === 'admin_broadcast') {
    const parts = text.split('|');
    const amount = parseFloat(parts[0]);
    const desc = parts[1]?.trim() || 'Admin Special Bonus';
    if (!amount) return bot.sendMessage(chatId, '❌ Format: amount|message\nExample: 5|Special Bonus');

    const users = await User.find({ isAdmin: false, isBlocked: false });
    let count = 0;
    for (const u of users) {
      u.balance += amount;
      u.totalEarned += amount;
      await u.save();
      await Transaction.create({
        userId: u._id, type: 'admin_credit',
        amount, description: desc, status: 'completed'
      });
      // Telegram notify
      if (u.telegramId) {
        bot.sendMessage(u.telegramId,
          `🎁 *${desc}*\n\n💰 ₹${amount} aapke account mein add hua!\nBalance: ₹${u.balance.toFixed(2)}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
      count++;
    }
    sessions[chatId] = {};
    return bot.sendMessage(chatId, `✅ ${count} users ko ₹${amount} diya gaya!`);
  }
});

// ===== CALLBACK HANDLER =====
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const msgId = query.message.message_id;

  bot.answerCallbackQuery(query.id);

  const user = await User.findOne({ telegramId: String(chatId) });

  // ===== MAIN MENU ACTIONS =====
  if (data === 'menu_home') {
    if (!user) return bot.sendMessage(chatId, '/start karo pehle');
    return showMainMenu(chatId, user);
  }

  if (data === 'menu_balance') {
    if (!user) return;
    const txns = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(5);
    let txnText = txns.length > 0
      ? txns.map(t => `${t.amount >= 0 ? '➕' : '➖'} ₹${Math.abs(t.amount)} - ${t.description || t.type}`).join('\n')
      : 'Koi transaction nahi';

    return bot.editMessageText(
      `💼 *Aapka Balance*\n\n` +
      `💰 Available: *₹${user.balance.toFixed(2)}*\n` +
      `📈 Total Kamaya: ₹${user.totalEarned.toFixed(2)}\n` +
      `👥 Total Refers: ${user.referCount}\n\n` +
      `📜 *Last 5 Transactions:*\n${txnText}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu_home' }]] }
      }
    );
  }

  if (data === 'menu_refer') {
    if (!user) return;
    const settings = await Settings.findOne();
    const botInfo = await bot.getMe();
    const link = `https://t.me/${botInfo.username}?start=${user.referCode}`;

    return bot.editMessageText(
      `🔗 *Refer Karo Kamaao!*\n\n` +
      `Aapka Refer Code: \`${user.referCode}\`\n\n` +
      `📤 Invite Link:\n${link}\n\n` +
      `💰 Har refer pe: *₹${settings?.referBonus || 2}*\n` +
      `👥 Aapne abhi tak ${user.referCount} log refer kiye\n` +
      `💵 Refer se kamaya: ₹${(user.referCount * (settings?.referBonus || 2)).toFixed(2)}\n\n` +
      `_Link share karo aur paisa kamaao!_ 🚀`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📤 Share Karo', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('💰 ReferEarn join karo aur paise kamaao!')}` }],
            [{ text: '🏠 Menu', callback_data: 'menu_home' }]
          ]
        }
      }
    );
  }

  if (data === 'menu_leaderboard') {
    const users = await User.find({ isAdmin: false, isBlocked: false })
      .sort({ referCount: -1 }).limit(10);

    const medals = ['🥇', '🥈', '🥉'];
    let text = `🏆 *Top 10 Leaderboard*\n\n`;
    users.forEach((u, i) => {
      const medal = medals[i] || `${i + 1}.`;
      text += `${medal} *${u.name}* - ${u.referCount} refers (₹${u.totalEarned})\n`;
    });

    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu_home' }]] }
    });
  }

  if (data === 'menu_invites') {
    if (!user) return;
    const invites = await User.find({ referredBy: user.phone }).sort({ createdAt: -1 }).limit(20);
    let text = `👥 *Mere Invites (${invites.length})*\n\n`;
    if (invites.length > 0) {
      invites.forEach((u, i) => {
        text += `${i + 1}. *${u.name}* - ${u.phone.replace(/.(?=.{4})/g, '*')}\n   📅 ${new Date(u.createdAt).toLocaleDateString('hi-IN')}\n`;
      });
    } else {
      text += '_Abhi tak koi nahi join kiya_\n\nApna refer code share karo!';
    }

    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🔗 Refer Link', callback_data: 'menu_refer' }, { text: '🏠 Menu', callback_data: 'menu_home' }]] }
    });
  }

  if (data === 'menu_daily_bonus') {
    if (!user) return;
    const settings = await Settings.findOne();
    const dailyBonus = settings?.dailyBonus || 5;
    const now = new Date();
    const lastClaim = user.lastBonusClaim;

    if (lastClaim) {
      const diff = (now - lastClaim) / (1000 * 60 * 60);
      if (diff < 24) {
        const remaining = 24 - diff;
        const h = Math.floor(remaining);
        const m = Math.floor((remaining - h) * 60);
        return bot.editMessageText(
          `⏰ *Daily Bonus Already Claim Ho Gaya*\n\n` +
          `Agli baar: *${h} ghante ${m} minute* baad\n\n` +
          `Kal wapas aana! 😊`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu_home' }]] }
          }
        );
      }
    }

    user.balance += dailyBonus;
    user.totalEarned += dailyBonus;
    user.lastBonusClaim = now;
    await user.save();

    await Transaction.create({
      userId: user._id, type: 'daily_bonus',
      amount: dailyBonus, description: '24 Hour Daily Bonus', status: 'completed'
    });

    return bot.editMessageText(
      `🎁 *Daily Bonus Mila!*\n\n` +
      `💰 +₹${dailyBonus} aapke account mein!\n` +
      `💼 Naya Balance: *₹${user.balance.toFixed(2)}*\n\n` +
      `Kal phir aana! 😊`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu_home' }]] }
      }
    );
  }

  if (data === 'menu_withdraw') {
    if (!user) return;
    const settings = await Settings.findOne();

    if (!user.withdrawalNumber) {
      sessions[chatId] = { step: 'set_wd_number' };
      return bot.editMessageText(
        `💸 *Withdrawal*\n\n` +
        `⚠️ Pehle withdrawal number set karo!\n\n` +
        `UPI ID ya Bank Account number daalo:`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu_home' }]] }
        }
      );
    }

    sessions[chatId] = { step: 'withdraw_amount' };
    return bot.editMessageText(
      `💸 *Withdrawal Request*\n\n` +
      `💼 Balance: ₹${user.balance.toFixed(2)}\n` +
      `📱 Number: ${user.withdrawalNumber}\n\n` +
      `Min: ₹${settings?.minWithdrawal || 20} | Max: ₹${settings?.maxWithdrawal || 500}\n\n` +
      `Kitna withdraw karna hai? Amount daalo:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '📱 Number Change', callback_data: 'change_wd_num' }, { text: '❌ Cancel', callback_data: 'menu_home' }]] }
      }
    );
  }

  if (data === 'change_wd_num') {
    sessions[chatId] = { step: 'set_wd_number' };
    return bot.editMessageText('📱 Naya withdrawal number daalo (UPI ID ya Account):', {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'menu_home' }]] }
    });
  }

  // Withdrawal method select
  if (data === 'wd_upi' || data === 'wd_csv') {
    const session = sessions[chatId] || {};
    if (!session.amount) return bot.sendMessage(chatId, 'Session expire ho gayi. Dobara try karo.');

    const method = data === 'wd_upi' ? 'upi' : 'csv';
    const freshUser = await User.findOne({ telegramId: String(chatId) });
    const settings = await Settings.findOne();

    if (!freshUser || freshUser.balance < session.amount) {
      sessions[chatId] = {};
      return bot.editMessageText('❌ Balance kam hai!', { chat_id: chatId, message_id: msgId });
    }

    freshUser.balance -= session.amount;
    await freshUser.save();

    const withdrawal = await Withdrawal.create({
      userId: freshUser._id,
      amount: session.amount,
      method,
      withdrawalNumber: freshUser.withdrawalNumber,
      status: 'processing'
    });

    await Transaction.create({
      userId: freshUser._id, type: 'withdrawal',
      amount: -session.amount,
      description: `${method.toUpperCase()} Withdrawal to ${freshUser.withdrawalNumber}`,
      status: 'completed'
    });

    sessions[chatId] = {};

    // Admin ko notify karo
    const adminId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (adminId) {
      bot.sendMessage(adminId,
        `💸 *Naya Withdrawal Request!*\n\n` +
        `👤 User: ${freshUser.name} (${freshUser.phone})\n` +
        `💰 Amount: ₹${session.amount}\n` +
        `📱 Number: ${freshUser.withdrawalNumber}\n` +
        `🏦 Method: ${method.toUpperCase()}\n` +
        `🆔 ID: \`${withdrawal._id}\``,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `approve_${withdrawal._id}` },
                { text: '❌ Reject', callback_data: `reject_${withdrawal._id}` }
              ]
            ]
          }
        }
      ).catch(() => {});
    }

    return bot.editMessageText(
      `✅ *Withdrawal Request Send Ho Gayi!*\n\n` +
      `💰 Amount: ₹${session.amount}\n` +
      `📱 To: ${freshUser.withdrawalNumber}\n` +
      `🏦 Method: ${method.toUpperCase()}\n\n` +
      `_Processing mein hai, jaldi aa jayega!_ ⏳`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu_home' }]] }
      }
    );
  }

  if (data === 'wd_cancel') {
    sessions[chatId] = {};
    return showMainMenu(chatId, user);
  }

  // ===== ADMIN CALLBACKS =====
  if (data === 'admin_panel') {
    if (!user?.isAdmin) return;
    return showAdminPanel(chatId, msgId);
  }

  if (data === 'admin_stats') {
    if (!user?.isAdmin) return;
    const totalUsers = await User.countDocuments({ isAdmin: false });
    const todayUsers = await User.countDocuments({
      createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) }, isAdmin: false
    });
    const totalW = await Withdrawal.aggregate([
      { $match: { status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pendingW = await Withdrawal.countDocuments({ status: 'pending' });

    return bot.editMessageText(
      `📊 *Admin Stats*\n\n` +
      `👥 Total Users: ${totalUsers}\n` +
      `🆕 Aaj Joined: ${todayUsers}\n` +
      `💸 Total Withdrawn: ₹${totalW[0]?.total || 0}\n` +
      `⏳ Pending Withdrawals: ${pendingW}`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin_panel' }]] }
      }
    );
  }

  if (data === 'admin_set_refer_bonus') {
    if (!user?.isAdmin) return;
    sessions[chatId] = { step: 'admin_set_refer' };
    return bot.editMessageText('💰 Naya refer bonus amount daalo (₹):', {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_panel' }]] }
    });
  }

  if (data === 'admin_set_daily_bonus') {
    if (!user?.isAdmin) return;
    sessions[chatId] = { step: 'admin_set_daily' };
    return bot.editMessageText('⚡ Naya daily bonus amount daalo (₹):', {
      chat_id: chatId, message_id: msgId,
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_panel' }]] }
    });
  }

  if (data === 'admin_broadcast') {
    if (!user?.isAdmin) return;
    sessions[chatId] = { step: 'admin_broadcast' };
    return bot.editMessageText(
      `📢 *Sabko Bonus Do*\n\nFormat: \`amount|message\`\nExample: \`5|Eid Special Bonus\``,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin_panel' }]] }
                        }
