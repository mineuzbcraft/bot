const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY = process.env.API_KEY || '';
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var');
  process.exit(1);
}

// Create bot instance
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Data storage file
const DATA_FILE = path.join(__dirname, 'bot-data.json');

// Load data from file
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading data:', error);
  }
  return { users: {}, pairingCodes: {} };
}

// Save data to file
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Initialize data
let botData = loadData();

// Expo Push Notification function
async function sendExpoPushNotification(pushToken, title, body, data = {}) {
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        to: pushToken,
        sound: 'default',
        title,
        body,
        data,
      }),
    });

    const result = await response.json();
    console.log('Push notification sent:', result);
    return result;
  } catch (error) {
    console.error('Failed to send push notification:', error);
    throw error;
  }
}

// Daily stats at 21:00 (9 PM)
function sendDailyStats() {
  const now = new Date();
  const hour = now.getHours();

  // Check if it's 21:00 (9 PM)
  if (hour === 21) {
    const today = now.toISOString().split('T')[0];

    // Send to all connected users
    Object.values(botData.users).forEach(async (user) => {
      try {
        const stats = dailyStats[user.userId];

        let message;

        if (stats && stats.date === today) {
          // Real stats available
          if (stats.isOffline) {
            // User was offline
            message = 
              `📊 <b>KUNLIK STATISTIKA</b>\n\n` +
              `👤 ${stats.userName || user.userName} ${user.userSurname}\n` +
              `📅 Sana: ${today}\n\n` +
              `⚠️ <b>Internet aloqasi yo'q!</b>\n` +
              `Ilova ma'lumotlarni yubora olmadi.\n\n` +
              `🔥 Streak: ${stats.streak} kun\n` +
              `🎯 Maqsadlar: ${stats.goals} ta\n\n` +
              `💕 Internetni yoqing va ertaga qayta urinib ko'ring!`;
          } else {
            // Real data
            message = 
              `📊 <b>KUNLIK STATISTIKA</b>\n\n` +
              `👤 ${stats.userName || user.userName} ${user.userSurname}\n` +
              `📅 Sana: ${today}\n\n` +
              `✅ G'alaba: ${stats.wins}\n` +
              `❌ Mag'lubiyat: ${stats.misses}\n` +
              `🔥 Streak: ${stats.streak} kun\n` +
              `🎯 Maqsadlar: ${stats.goals} ta\n\n`;

            // Add motivational message based on performance
            if (stats.wins > 0 && stats.misses === 0) {
              message += `💪 Ajoyib natija! Hamma maqsadlar bajarildi!`;
            } else if (stats.wins > stats.misses) {
              message += `🔘 Yaxshi natija! Davom eting!`;
            } else if (stats.wins === 0 && stats.misses === 0) {
              message += `📝 Bugun ma'lumot yo'q. Ertaga boshlang!`;
            } else {
              message += `💕 Ertaga yanada yaxshiroq bo'lsin!`;
            }
          }
        } else {
          // No data received
          message = 
            `📊 <b>KUNLIK STATISTIKA</b>\n\n` +
            `👤 ${user.userName} ${user.userSurname}\n` +
            `📅 Sana: ${today}\n\n` +
            `⚠️ Bugungi ma'lumotlar olinmadi.\n` +
            `Iltimos, ilovani oching va maqsadlaringizni belgilang!\n\n` +
            `💪 Ertaga yanada yaxshiroq bo'lsin!`;
        }

        await bot.sendMessage(user.chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        console.log(`Daily stats sent to ${user.userName}`);
      } catch (error) {
        console.error(`Failed to send daily stats to ${user.userName}:`, error);
      }
    });
  }
}

// Check every hour if it's 21:00
setInterval(sendDailyStats, 60 * 60 * 1000); // Check every hour
console.log('Daily stats scheduler started (21:00)');

// In-memory state: who is currently entering pairing code
const awaitingPairCode = new Set();
// Password reset codes storage (in-memory, expires in 15 minutes)
const passwordResetCodes = {};
// Daily stats storage (in-memory, expires daily)
const dailyStats = {};

// --- HTTP API for app -> bot pairing codes ---
const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/pairing', (req, res) => {
  // Optional simple protection (set API_KEY on server and in app)
  if (API_KEY) {
    const headerKey = req.header('x-api-key') || '';
    if (headerKey !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { code, userId, userName, userSurname, timestamp } = req.body || {};
  if (!code || !userId) return res.status(400).json({ ok: false, error: 'missing code/userId' });

  // Normalize and store (expires in 5 minutes via /pair check)
  const normalizedCode = String(code).trim();
  botData.pairingCodes[normalizedCode] = {
    userId: String(userId),
    userName: String(userName || ''),
    userSurname: String(userSurname || ''),
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
  };
  saveData(botData);

  return res.json({ ok: true });
});

app.post('/notify', async (req, res) => {
  // Optional simple protection (set API_KEY on server and in app)
  if (API_KEY) {
    const headerKey = req.header('x-api-key') || '';
    if (headerKey !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { userId, message, parseMode } = req.body || {};
  if (!userId || !message) return res.status(400).json({ ok: false, error: 'missing userId/message' });

  const targetUser = Object.values(botData.users).find(u => String(u.userId) === String(userId));
  if (!targetUser) return res.status(404).json({ ok: false, error: 'user_not_paired' });

  try {
    await bot.sendMessage(targetUser.chatId, String(message), {
      parse_mode: parseMode === 'HTML' ? 'HTML' : undefined,
      disable_web_page_preview: true,
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'send_failed' });
  }
});

// Request password reset via Telegram
app.post('/request-password-reset', async (req, res) => {
  // Optional simple protection
  if (API_KEY) {
    const headerKey = req.header('x-api-key') || '';
    if (headerKey !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { userId, userName } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'missing userId' });

  // Find user in botData
  const targetUser = Object.values(botData.users).find(u => String(u.userId) === String(userId));
  if (!targetUser) {
    return res.status(404).json({ ok: false, error: 'user_not_paired' });
  }

  // Generate 6-digit reset code
  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();

  // Store reset code (expires in 15 minutes)
  passwordResetCodes[resetCode] = {
    userId: String(userId),
    timestamp: Date.now(),
    expiresAt: Date.now() + (15 * 60 * 1000), // 15 minutes
    userName: userName || targetUser.userName || ''
  };

  try {
    // Send reset code via Telegram
    await bot.sendMessage(targetUser.chatId, 
      `🔐 <b>PAROLNI QAYTA TIKLASH</b>\n\n` +
      `👤 ${userName || targetUser.userName}\n\n` +
      `Kod: <code>${resetCode}</code>\n\n` +
      `⏰ Bu kod <b>15 daqiqa</b> amal qiladi\n` +
      `⚠️ Bu kodni hech kimga bermang!`,
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }
    );

    console.log(`Password reset code sent: ${resetCode} for user ${userId}`);
    return res.json({ ok: true, message: 'Reset code sent via Telegram' });
  } catch (e) {
    console.error('Error sending reset code:', e);
    return res.status(500).json({ ok: false, error: 'send_failed' });
  }
});

// Verify password reset code
app.post('/verify-reset-code', (req, res) => {
  // Optional simple protection
  if (API_KEY) {
    const headerKey = req.header('x-api-key') || '';
    if (headerKey !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { code, userId } = req.body || {};
  if (!code || !userId) return res.status(400).json({ ok: false, error: 'missing code/userId' });

  const resetData = passwordResetCodes[String(code).trim()];

  if (!resetData) {
    return res.status(400).json({ ok: false, error: 'invalid_code', message: 'Kod topilmadi' });
  }

  // Check if code is expired
  if (Date.now() > resetData.expiresAt) {
    delete passwordResetCodes[String(code).trim()];
    return res.status(400).json({ ok: false, error: 'expired', message: 'Kod muddati tugagan' });
  }

  // Check if userId matches
  if (resetData.userId !== String(userId)) {
    return res.status(400).json({ ok: false, error: 'user_mismatch', message: 'Foydalanuvchi mos kelmadi' });
  }

  // Code is valid, delete it (one-time use)
  delete passwordResetCodes[String(code).trim()];

  return res.json({ ok: true, verified: true, message: 'Kod tasdiqlandi' });
});

// Endpoint to receive daily stats from app
app.post('/daily-stats', (req, res) => {
  // Optional simple protection
  if (API_KEY) {
    const headerKey = req.header('x-api-key') || '';
    if (headerKey !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { userId, date, wins, misses, streak, goals, userName, isOffline } = req.body || {};
  if (!userId || !date) return res.status(400).json({ ok: false, error: 'missing userId/date' });

  // Store daily stats
  dailyStats[userId] = {
    userId,
    date,
    wins: wins || 0,
    misses: misses || 0,
    streak: streak || 0,
    goals: goals || 0,
    userName: userName || '',
    isOffline: isOffline || false,
    receivedAt: Date.now()
  };

  console.log(`Daily stats received for user ${userId} (${userName}):`, dailyStats[userId]);

  return res.json({ ok: true, message: 'Stats received' });
});

// Register push token
app.post('/register-push-token', (req, res) => {
  if (API_KEY) {
    const headerKey = req.header('x-api-key') || '';
    if (headerKey !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { userId, pushToken } = req.body || {};
  if (!userId || !pushToken) return res.status(400).json({ ok: false, error: 'missing userId/pushToken' });

  // Find user and update push token
  const targetUser = Object.values(botData.users).find(u => String(u.userId) === String(userId));
  if (!targetUser) {
    return res.status(404).json({ ok: false, error: 'user_not_paired' });
  }

  targetUser.pushToken = pushToken;
  saveData(botData);

  console.log(`Push token registered for user ${userId}`);

  return res.json({ ok: true, message: 'Push token registered' });
});

// Fetch real-time stats from app (app calls this to update stats)
app.post('/fetch-stats', (req, res) => {
  if (API_KEY) {
    const headerKey = req.header('x-api-key') || '';
    if (headerKey !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { userId, date, wins, misses, streak, goals, userName } = req.body || {};
  if (!userId || !date) return res.status(400).json({ ok: false, error: 'missing userId/date' });

  // Update stats
  dailyStats[userId] = {
    userId,
    date,
    wins: wins || 0,
    misses: misses || 0,
    streak: streak || 0,
    goals: goals || 0,
    userName: userName || '',
    isOffline: false,
    receivedAt: Date.now()
  };

  console.log(`Real-time stats updated for user ${userId}:`, dailyStats[userId]);

  return res.json({ ok: true, message: 'Stats updated' });
});

app.listen(PORT, () => {
  console.log(`HTTP API listening on :${PORT}`);
});

function handlePairingCode(chatId, codeRaw) {
  const code = String(codeRaw || '').trim();
  if (!code) {
    bot.sendMessage(chatId, '❌ Kod bo\'sh. 6 xonali kodni yuboring.');
    return;
  }

  // Check if pairing code exists
  if (botData.pairingCodes[code]) {
    const pairingData = botData.pairingCodes[code];

    // Check if code is still valid (5 minutes)
    const timeDiff = Date.now() - pairingData.timestamp;
    if (timeDiff > 5 * 60 * 1000) {
      bot.sendMessage(chatId, '❌ Kod muddati tugadi. Ilovadan qayta kod oling.');
      return;
    }

    // Check if user is already connected
    const existingUser = Object.values(botData.users).find(u => u.userId === pairingData.userId);
    if (existingUser) {
      // Update chatId if user reconnects
      existingUser.chatId = chatId;
      saveData(botData);
      bot.sendMessage(chatId, `✅ Qayta ulandi!\n\n👤 ${pairingData.userName} ${pairingData.userSurname}\n🆔 ID: ${pairingData.userId}`);
      return;
    }

    // Connect user
    botData.users[chatId] = {
      chatId: chatId,
      userId: pairingData.userId,
      userName: pairingData.userName,
      userSurname: pairingData.userSurname,
      connectedAt: Date.now()
    };

    // Remove used pairing code
    delete botData.pairingCodes[code];
    saveData(botData);

    bot.sendMessage(chatId, `
✅ Muvaffaqiyatli ulandi!

👤 Ism: ${pairingData.userName}
👤 Familiya: ${pairingData.userSurname}
🆔 ID: ${pairingData.userId}

📊 Statistika: /stat
📢 Notification: /send
    `);

    // Set bot commands
    bot.setMyCommands([
      { command: 'start', description: 'Botni boshlash' },
      { command: 'pair', description: 'Ilova bilan ulanish' },
      { command: 'stat', description: 'Statistika ko\'rish' },
      { command: 'send', description: 'Notification yuborish' },
      { command: 'reset', description: 'Parolni tiklash' },
      { command: 'disconnect', description: 'Ulanishni uzish' },
      { command: 'help', description: 'Yordam' }
    ]);
  } else {
    bot.sendMessage(chatId, '❌ Noto\'g\'ri kod. Kodni tekshiring va qayta urinib ko\'ring.');
  }
}

// /start command with menu
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = botData.users[chatId];
  
  const menuKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔗 Ilova bilan ulanish', callback_data: 'pair' },
          { text: '📊 Statistika', callback_data: 'stat' }
        ],
        [
          { text: '📢 Notification', callback_data: 'send' },
          { text: '🔐 Parolni tiklash', callback_data: 'reset' }
        ],
        [
          { text: '❌ Ulanishni uzish', callback_data: 'disconnect' },
          { text: '❓ Yordam', callback_data: 'help' }
        ]
      ]
    }
  };

  if (user) {
    bot.sendMessage(chatId, `
🏆 <b>MSR F Team Alarm Bot</b>

👤 Foydalanuvchi: ${user.userName} ${user.userSurname}
🆔 ID: ${user.userId}
✅ Ulangan

📋 Menyu:
🔗 /pair - Ilova bilan ulanish
📊 /stat - Statistika ko'rish
📢 /send - Notification yuborish
🔐 /reset - Parolni tiklash
❌ /disconnect - Ulanishni uzish
❓ /help - Yordam
    `, { parse_mode: 'HTML', ...menuKeyboard });
  } else {
    bot.sendMessage(chatId, `
🏆 <b>MSR F Team Alarm Bot</b>

❌ Hali ulanmagan

📋 Menyu:
🔗 /pair - Ilova bilan ulanish
❓ /help - Yordam

Ulanish uchun:
1. Ilovada "BOTNI ULASH" tugmasini bosing
2. Kodni nusxa qiling
3. /pair kod yuboring
    `, { parse_mode: 'HTML', ...menuKeyboard });
  }
});

// Callback query handler
bot.on('callback_query', (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  switch (data) {
    case 'pair':
      awaitingPairCode.add(chatId);
      bot.sendMessage(chatId, `
🔗 Ulanish kodi

Ilovada chiqqan 6 xonali kodni shu yerga yuboring.
Masalan: 123456
      `);
      break;
    case 'stat':
      handleStatCommand(chatId);
      break;
    case 'send':
      handleSendCommand(chatId);
      break;
    case 'reset':
      handleResetCommand(chatId);
      break;
    case 'disconnect':
      handleDisconnectCommand(chatId);
      break;
    case 'help':
      bot.sendMessage(chatId, `
🏆 <b>MSR F Team Alarm Bot - Yordam</b>

📋 Buyruqlar:
/start - Botni boshlash va menyu
/pair - Ilova bilan ulanish
/stat - Statistika ko'rish
/send - Notification yuborish
/reset - Parolni tiklash
/disconnect - Ulanishni uzish
/help - Yordam

🔗 Ulanish:
1. Ilovada "BOTNI ULASH" tugmasini bosing
2. Kodni nusxa qiling
3. Telegramda /pair kod yuboring
4. Muvaffaqiyatli ulanishingiz!

❓ Savollar uchun: @msrfteam
      `, { parse_mode: 'HTML' });
      break;
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

// Helper functions
async function handleStatCommand(chatId) {
  const user = botData.users[chatId];
  if (!user) {
    bot.sendMessage(chatId, '❌ Avval ilova bilan ulaning. /pair buyrug\'idan foydalaning.');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  
  // Try to fetch real-time data from app (if user has push token)
  if (user.pushToken) {
    try {
      // Send push notification to app to request stats
      await sendExpoPushNotification(
        user.pushToken,
        '📊 Statistika so\'rovi',
        'Bot statistikani so\'rayapti...',
        { type: 'fetch_stats_request', userId: user.userId }
      );
      
      // Wait a bit for app to respond
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('Failed to request stats from app:', error);
    }
  }

  const stats = dailyStats[user.userId];

  let message = `📊 Statistika - ${user.userName} ${user.userSurname}\n\n🆔 ID: ${user.userId}`;

  if (stats && stats.date === today) {
    message += `\n\n📅 Bugun (${today}):`;
    if (stats.isOffline) {
      message += `\n⚠️ Internet aloqasi yo'q`;
    } else {
      message += `\n✅ Bajarildi: ${stats.wins}`;
      message += `\n❌ Bajarilmadi: ${stats.misses}`;
    }
    message += `\n🔥 Streak: ${stats.streak} kun`;
    message += `\n🎯 Maqsadlar: ${stats.goals} ta`;
  } else {
    message += `\n\n📅 Bugun: (Ma'lumot yo'q)`;
    message += `\n📆 Oylik: (Ma'lumot yo'q)`;
    message += `\n🔥 Streak: (Ma'lumot yo'q)`;
    message += `\n\n⚠️ Ilovani oching va bugungi maqsadlarni bajaring!`;
  }

  bot.sendMessage(chatId, message);
}

function handleSendCommand(chatId) {
  const user = botData.users[chatId];
  if (!user) {
    bot.sendMessage(chatId, '❌ Avval ilova bilan ulaning. /pair buyrug\'idan foydalaning.');
    return;
  }

  bot.sendMessage(chatId, `
📢 Notification yuborish

Ilovaga notification yuborish uchun /send xabar buyrug\'idan foydalaning.
Masalan: /send Ertalab mashq qilishni unutmang!

👤 Qabul qiluvchi: ${user.userName} ${user.userSurname}
🆔 ID: ${user.userId}
  `);
}

function handleResetCommand(chatId) {
  const user = botData.users[chatId];
  if (!user) {
    bot.sendMessage(chatId, '❌ Avval ilova bilan ulangan bo\'lishingiz kerak.');
    return;
  }

  bot.sendMessage(chatId, `
🔐 Parolni tiklash

Parolni tiklash uchun ilovada "Parolni unutdim" tugmasini bosing.
Kod Telegram orqali yuboriladi.

⏰ Kod 15 daqiqa amal qiladi
⚠️ Kodni hech kimga bermang!
  `);
}

function handleDisconnectCommand(chatId) {
  const user = botData.users[chatId];
  if (!user) {
    bot.sendMessage(chatId, '❌ Siz allaqachon ulanmagan.');
    return;
  }

  delete botData.users[chatId];
  saveData(botData);

  bot.sendMessage(chatId, `
❌ Ulanish uzildi

Siz bot bilan ulanishingizni uzdingiz.
Qayta ulanish uchun /pair buyrug\'idan foydalaning.
  `);
}

// /pair command (without code)
bot.onText(/^\/pair$/, (msg) => {
  const chatId = msg.chat.id;
  awaitingPairCode.add(chatId);
  bot.sendMessage(chatId, `
🔗 Ulanish kodi

Ilovada chiqqan 6 xonali kodni shu yerga yuboring.
Masalan: 123456
  `);
});

// /pair with code (e.g., /pair 123456)
bot.onText(/^\/pair\s+(.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();

  awaitingPairCode.delete(chatId);
  handlePairingCode(chatId, code);
});

// After /pair, accept next normal message as code
bot.on('message', (msg) => {
  const chatId = msg.chat?.id;
  const text = msg.text;
  if (!chatId || typeof text !== 'string') return;
  if (!awaitingPairCode.has(chatId)) return;

  // If user sends another command, keep waiting
  if (text.trim().startsWith('/')) return;

  awaitingPairCode.delete(chatId);
  handlePairingCode(chatId, text);
});

// /stat command
bot.onText(/\/stat/, (msg) => {
  handleStatCommand(msg.chat.id);
});

// /send command
bot.onText(/\/send(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = botData.users[chatId];

  if (!user) {
    bot.sendMessage(chatId, '❌ Avval ilova bilan ulangan bo\'lishingiz kerak. /pair buyrug\'idan foydalaning.');
    return;
  }

  const message = match[1] || 'Test notification';

  // Send notification to app via Expo Push Notifications
  let pushSent = false;
  if (user.pushToken) {
    try {
      await sendExpoPushNotification(
        user.pushToken,
        '🔔 Telegramdan Xabar',
        message,
        { type: 'telegram_message' }
      );
      pushSent = true;
    } catch (error) {
      console.error('Failed to send push notification:', error);
    }
  }

  // Send confirmation to Telegram
  if (pushSent) {
    bot.sendMessage(chatId, `
✅ Notification yuborildi

Xabar: "${message}"

👤 Qabul qiluvchi: ${user.userName} ${user.userSurname}
🆔 ID: ${user.userId}

✅ Ilovaga notification yuborildi!
    `);
  } else {
    bot.sendMessage(chatId, `
⚠️ Notification yuborilmadi

Xabar: "${message}"

👤 Qabul qiluvchi: ${user.userName} ${user.userSurname}
🆔 ID: ${user.userId}

❌ Push token topilmadi. Ilovani oching va push token ro'yxatdan o'tkazing.
    `);
  }
});

// /reset command
bot.onText(/\/reset/, (msg) => {
  handleResetCommand(msg.chat.id);
});

// /disconnect command
bot.onText(/\/disconnect/, (msg) => {
  handleDisconnectCommand(msg.chat.id);
});

// /help command
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🏆 <b>MSR F Team Alarm Bot - Yordam</b>

📋 Buyruqlar:
/start - Botni boshlash va menyu
/pair - Ilova bilan ulanish
/stat - Statistika ko'rish
/send - Notification yuborish
/reset - Parolni tiklash
/disconnect - Ulanishni uzish
/help - Yordam

🔗 Ulanish:
1. Ilovada "BOTNI ULASH" tugmasini bosing
2. Kodni nusxa qiling
3. Telegramda /pair kod yuboring
4. Muvaffaqiyatli ulanishingiz!

❓ Savollar uchun: @msrfteam
  `, { parse_mode: 'HTML' });
});

console.log('Bot is running...');
