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
// In-memory state: who is currently entering pairing code
const awaitingPairCode = new Set();
// Password reset codes storage (in-memory, expires in 15 minutes)
const passwordResetCodes = {};

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

app.listen(PORT, () => {
  console.log(`HTTP API listening on :${PORT}`);
});

function handlePairingCode(chatId, codeRaw) {
  const code = String(codeRaw || '').trim();
  if (!code) {
    bot.sendMessage(chatId, '❌ Kod bo‘sh. 6 xonali kodni yuboring.');
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
      { command: 'send', description: 'Notification yuborish' }
    ]);
  } else {
    bot.sendMessage(chatId, '❌ Noto\'g\'ri kod. Kodni tekshiring va qayta urinib ko\'ring.');
  }
}

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, `
🏆 MSR F Team Alarm Bot

📋 Buyruqlar:
/pair - Ilova bilan ulanish
/stat - Statistika ko'rish
/send - Notification yuborish
/help - Yordam

Ilova bilan ulanish uchun /pair buyrug'ini bosing va kodni kiriting.
  `);
});

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
  const chatId = msg.chat.id;
  const user = botData.users[chatId];
  
  if (!user) {
    bot.sendMessage(chatId, '❌ Avval ilova bilan ulaning. /pair buyrug\'idan foydalaning.');
    return;
  }
  
  // Here you would fetch actual stats from your app database
  // For now, send a placeholder message
  bot.sendMessage(chatId, `
📊 Statistika - ${user.userName} ${user.userSurname}

🆔 ID: ${user.userId}

📅 Bugun: (Ma\'lumot yo\'q)
📆 Oylik: (Ma\'lumot yo\'q)
🔥 Streak: (Ma\'lumot yo\'q)

⚠️ Bu bot server ilova bilan aloqa qilishi kerak.
  `);
});

// /send command
bot.onText(/\/send(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const user = botData.users[chatId];
  
  if (!user) {
    bot.sendMessage(chatId, '❌ Avval ilova bilan ulaning. /pair buyrug\'idan foydalaning.');
    return;
  }
  
  const message = match[1] || 'Test notification';
  
  // Here you would send notification to the app via Expo Push Notifications
  // For now, just confirm
  bot.sendMessage(chatId, `
📢 Notification yuborildi

Xabar: "${message}"

👤 Qabul qiluvchi: ${user.userName} ${user.userSurname}
🆔 ID: ${user.userId}

⚠️ Bu notification ilovaga yuborilishi kerak.
  `);
});

// /help command
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🏆 MSR F Team Alarm Bot - Yordam

📋 Buyruqlar:
/start - Botni boshlash
/pair - Ilova bilan ulanish
/stat - Statistika ko'rish
/send - Notification yuborish
/help - Yordam

🔗 Ulanish:
1. Ilovada "KOD GENERATSIYA QILISH" tugmasini bosing
2. Kodni nusxa qiling
3. Telegramda /pair kod yuboring
4. Muvaffaqiyatli ulanishingiz!

❓ Savollar uchun: @msrfteam
  `);
});

// Webhook endpoint for app to send pairing codes
// You can deploy this to a server like Render, Heroku, etc.
// For now, this is a simple polling bot

console.log('Bot is running...');
