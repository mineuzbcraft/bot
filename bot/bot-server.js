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

app.listen(PORT, () => {
  console.log(`HTTP API listening on :${PORT}`);
});

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

// /pair command
bot.onText(/\/pair/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, `
🔗 Ulanish kodi

Ilova generatsiya qilgan kodni kiriting:

Masalan: /pair 123456
  `);
});

// /pair with code
bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match[1].trim();
  
  // Check if pairing code exists
  if (botData.pairingCodes[code]) {
    const pairingData = botData.pairingCodes[code];
    
    // Check if code is still valid (5 minutes)
    const timeDiff = Date.now() - pairingData.timestamp;
    if (timeDiff > 5 * 60 * 1000) {
      bot.sendMessage(chatId, '❌ Kod muddati tugadi. Qayta kod oling.');
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
