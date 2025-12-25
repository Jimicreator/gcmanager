const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const crypto = require('crypto');
const connectToDatabase = require('../../db');
const roasts = require('../../roast_data.json');

// Initialize Bot
const bot = new TelegramBot(process.env.BOT_TOKEN);

// --- MONGODB SCHEMAS ---
const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true },
  name: String,
  afk: { isAfk: Boolean, reason: String, time: Date },
  birthday: String, // DD-MM
  crimeRecord: {
    muted: { type: Number, default: 0 },
    banned: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 }
  },
  kismatUsed: { type: String, default: "" }, // Stores Date string to limit 1 per day
  aukaatUsed: { type: String, default: "" }
});

const groupSchema = new mongoose.Schema({
  chatId: { type: String, required: true },
  settings: {
    roast: { type: Boolean, default: true },
    kismat: { type: Boolean, default: true },
    confess: { type: Boolean, default: true },
    challan: { type: Boolean, default: true }
  },
  locked: {
    all: { type: Boolean, default: false },
    media: { type: Boolean, default: false },
    text: { type: Boolean, default: false }
  },
  lastConfessionId: Number // For Smart Delete
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Group = mongoose.models.Group || mongoose.model('Group', groupSchema);

// --- HELPER FUNCTIONS ---
async function isAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(member.status);
  } catch (e) { return false; }
}

async function getGroup(chatId) {
  let group = await Group.findOne({ chatId });
  if (!group) group = await Group.create({ chatId });
  return group;
}

async function getUser(userId, name) {
  let user = await User.findOne({ userId });
  if (!user) user = await User.create({ userId, name, afk: { isAfk: false } });
  return user;
}

// --- MAIN HANDLER (NETLIFY) ---
exports.handler = async (event) => {
  // 1. Only allow POST requests (Webhooks)
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "Inspector Chingum Active!" };

  // 2. Connect to Database
  await connectToDatabase();

  try {
    const body = JSON.parse(event.body);

    // --- A. HANDLE INLINE QUERY (WHISPER 2.0) ---
    if (body.inline_query) {
      const query = body.inline_query;
      const text = query.query; // "whisper @user secret"
      
      if (!text.startsWith("whisper")) return { statusCode: 200 };

      const parts = text.split(" ");
      if (parts.length < 3) return { statusCode: 200 };

      const targetUsername = parts[1]; // @User
      const secretMessage = parts.slice(2).join(" ");
      
      // Encode secret in base64 to hide it in the button callback
      const encodedSecret = Buffer.from(secretMessage).toString('base64');
      const uniqueId = crypto.randomBytes(4).toString('hex');

      const results = [{
        type: 'article',
        id: uniqueId,
        title: '🤫 Send Whisper',
        description: `Secret message for ${targetUsername}`,
        input_message_content: {
          message_text: `🔒 **GUPT SANDESH (WHISPER)**\n\n👤 **To:** ${targetUsername}\n📨 **From:** Anonymous\n\n*Tap below to read.*`,
          parse_mode: 'Markdown'
        },
        reply_markup: {
          inline_keyboard: [[{ text: "🔐 Unlock Message", callback_data: `whisper_${targetUsername}_${encodedSecret}` }]]
        }
      }];
      
      await bot.answerInlineQuery(query.id, results, { cache_time: 0 });
      return { statusCode: 200, body: "OK" };
    }

    // --- B. HANDLE CALLBACK QUERIES (BUTTON CLICKS) ---
    if (body.callback_query) {
      const query = body.callback_query;
      const data = query.data;
      const chatId = query.message.chat.id;
      const user = query.from;

      // 1. WHISPER UNLOCK
      if (data.startsWith("whisper_")) {
        const parts = data.split("_"); // [whisper, @target, encodedSecret]
        const targetUser = parts[1].replace("@", "");
        const secret = Buffer.from(parts[2], 'base64').toString('utf8');

        if (user.username && user.username.toLowerCase() === targetUser.toLowerCase()) {
          // Show alert (Toast) - Snapchat Style "Read Once"
          await bot.answerCallbackQuery(query.id, { text: secret, show_alert: true });
          // Edit message to expire it
          await bot.editMessageText(`❌ **MESSAGE EXPIRED**\nRead by @${targetUser}`, {
            inline_message_id: query.inline_message_id
          });
        } else {
          await bot.answerCallbackQuery(query.id, { text: "Ye message tumhare liye nahi hai! Nikal!", show_alert: true });
        }
      }
      
      // 2. CHALLAN ACTIONS
      else if (data.startsWith("mute_") || data.startsWith("ban_") || data.startsWith("forgive_")) {
        const adminStatus = await isAdmin(chatId, user.id);
        if (!adminStatus) {
          await bot.answerCallbackQuery(query.id, { text: "Tu Inspector nahi hai! Hatt!", show_alert: true });
          return { statusCode: 200 };
        }

        const targetId = data.split("_")[1];

        if (data.startsWith("mute_")) {
          await bot.restrictChatMember(chatId, targetId, { until_date: Math.floor(Date.now() / 1000) + 600, can_send_messages: false });
          await bot.editMessageText(roasts.challan.paid, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        } else if (data.startsWith("ban_")) {
          await bot.banChatMember(chatId, targetId);
          await bot.editMessageText(roasts.challan.banned, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        } else if (data.startsWith("forgive_")) {
          await bot.editMessageText(roasts.challan.forgive, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        }
      }
      return { statusCode: 200, body: "OK" };
    }

    // --- C. HANDLE TEXT MESSAGES ---
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const text = msg.text || "";
      const user = msg.from;
      const dbUser = await getUser(user.id, user.first_name);
      const dbGroup = await getGroup(chatId);

      // 1. SECTION 144 / LOCK CHECK
      if (dbGroup.locked.all && !(await isAdmin(chatId, user.id))) {
        await bot.deleteMessage(chatId, msg.message_id);
        return { statusCode: 200 };
      }

      // 2. AFK SYSTEM (WELCOME BACK & DEFENDER)
      // Check if Sender is back from AFK
      if (dbUser.afk.isAfk) {
        dbUser.afk.isAfk = false;
        await dbUser.save();
        
        // Admin Royal Entry
        if (await isAdmin(chatId, user.id)) {
           await bot.sendMessage(chatId, `🎺 **ATTENTION!** 🎺\n**${user.first_name}** Sahab padhaar chuke hain.`);
        } else {
           // Funny User Entry
           const randomMsg = roasts.afk_returns[Math.floor(Math.random() * roasts.afk_returns.length)].replace("@User", user.first_name);
           await bot.sendMessage(chatId, randomMsg);
        }
      }

      // Check if Sender tagged an AFK user
      if (msg.entities && msg.entities.some(e => e.type === 'mention' || e.type === 'text_mention')) {
         // (Requires complex logic to match UserID from mention, skipping for simplicity in Free Tier prototype. 
         // Basic text match for @Username is safer here)
      }

      // 3. AUTO WELCOME (NEW MEMBER)
      if (msg.new_chat_members) {
        for (const member of msg.new_chat_members) {
          if (!member.is_bot) {
            const randomIntro = roasts.welcome_messages[Math.floor(Math.random() * roasts.welcome_messages.length)].replace("@User", member.first_name);
            await bot.sendMessage(chatId, randomIntro, { parse_mode: 'Markdown' });
          }
        }
      }

      // --- COMMANDS ---

      // /challan (Reply Only)
      if (text.startsWith('/challan') && msg.reply_to_message) {
        if (await isAdmin(chatId, user.id)) {
           const target = msg.reply_to_message.from;
           const intro = roasts.challan.intro.replace("@User", target.first_name);
           const keyboard = {
             inline_keyboard: [
               [{ text: "🤫 Mute (10m)", callback_data: `mute_${target.id}` }, { text: "🔨 Ban", callback_data: `ban_${target.id}` }],
               [{ text: "😂 Maafi (Forgive)", callback_data: `forgive_${target.id}` }]
             ]
           };
           await bot.sendMessage(chatId, `${intro}\n🛑 **Offense:** ${roasts.challan.offense}`, { parse_mode: 'Markdown', reply_markup: keyboard });
        }
      }

      // /lock and /unlock
      else if (text.startsWith('/lock')) {
        if (await isAdmin(chatId, user.id)) {
          dbGroup.locked.all = true;
          await dbGroup.save();
          await bot.sendMessage(chatId, roasts.section_144, { parse_mode: 'Markdown' });
        }
      }
      else if (text.startsWith('/unlock')) {
        if (await isAdmin(chatId, user.id)) {
          dbGroup.locked.all = false;
          await dbGroup.save();
          await bot.sendMessage(chatId, "✅ **Section 144 Removed.**\nBolne ki aazadi wapas di jaati hai.");
        }
      }

      // /shout (Anon Broadcast) - Deletes original
      else if (text.startsWith('/shout')) {
        const shoutText = text.replace('/shout', '').trim();
        if (shoutText) {
          await bot.deleteMessage(chatId, msg.message_id); // Instant Delete
          const randomHeader = roasts.shout_intros[Math.floor(Math.random() * roasts.shout_intros.length)];
          await bot.sendMessage(chatId, `${randomHeader}\n\n"${shoutText}"`);
        }
      }

      // /confess (Smart Delete)
      else if (text.startsWith('/confess')) {
        const confessText = text.replace('/confess', '').trim();
        if (confessText) {
           await bot.deleteMessage(chatId, msg.message_id); // Delete command
           
           // Check DB for old confession to delete
           if (dbGroup.lastConfessionId) {
             try { await bot.deleteMessage(chatId, dbGroup.lastConfessionId); } catch(e) {}
           }
           
           const sentMsg = await bot.sendMessage(chatId, `🎩 **CONFESSION** 🎩\n\n"${confessText}"\n\n*(Purana paap mit gaya, naya aa gaya)*`);
           dbGroup.lastConfessionId = sentMsg.message_id;
           await dbGroup.save();
        }
      }

      // /kismat (Daily Logic)
      else if (text.startsWith('/kismat')) {
        const today = new Date().toISOString().split('T')[0];
        let targetUser = user;
        let isReply = false;
        
        if (msg.reply_to_message) {
          targetUser = msg.reply_to_message.from;
          isReply = true;
          const targetDb = await getUser(targetUser.id, targetUser.first_name);
          if (targetDb.kismatUsed !== today) {
             await bot.sendMessage(chatId, "✋ **Ruko!**\nInhe abhi khud hi nahi pata inki kismat. Pehle inko check karne do.");
             return { statusCode: 200 };
          }
        }
        
        // Generate Result
        const seed = `${targetUser.id}-${today}`;
        const hash = crypto.createHash('md5').update(seed).digest('hex');
        const luckScore = parseInt(hash.substring(0, 2), 16) % 101;
        
        let verdict = "";
        if (luckScore < 30) verdict = roasts.kismat.bad[luckScore % roasts.kismat.bad.length];
        else if (luckScore < 70) verdict = roasts.kismat.avg[luckScore % roasts.kismat.avg.length];
        else verdict = roasts.kismat.good[luckScore % roasts.kismat.good.length];

        const totka = roasts.totka[parseInt(hash.substring(2, 4), 16) % roasts.totka.length];

        await bot.sendMessage(chatId, `🔮 **Kismat: ${targetUser.first_name}**\n📊 Score: ${luckScore}%\n💬 "${verdict}"\n🍀 Totka: ${totka}`);
        
        // Save Usage
        if (!isReply) {
          dbUser.kismatUsed = today;
          await dbUser.save();
        }
      }

      // /aukaat (Valuation)
      else if (text.startsWith('/aukaat')) {
        const item = roasts.aukaat_val[Math.floor(Math.random() * roasts.aukaat_val.length)];
        await bot.sendMessage(chatId, `💰 **Market Value of ${user.first_name}:**\n👉 ${item}`);
      }

      // /afk
      else if (text.startsWith('/afk')) {
        const reason = text.replace('/afk', '').trim() || "Sleeping";
        dbUser.afk = { isAfk: true, reason: reason, time: new Date() };
        await dbUser.save();
        await bot.sendMessage(chatId, `💤 **${user.first_name} is now AFK.**\nReason: ${reason}\n*(Disturb mat karna)*`);
      }
      
      // /saaf (Cleaner)
      else if (text.startsWith('/saaf')) {
        if (await isAdmin(chatId, user.id)) {
           const count = parseInt(text.split(" ")[1]) || 5;
           // Limit to 50 for safety
           const safeCount = Math.min(count, 50); 
           try {
              for (let i = 0; i < safeCount; i++) {
                 await bot.deleteMessage(chatId, msg.message_id - i);
              }
           } catch (e) {
              await bot.sendMessage(chatId, "Kuch messages purane hain, delete nahi ho rahe.");
           }
        }
      }

      // /jhatka (Fake Ban)
      else if (text.startsWith('/jhatka') && msg.reply_to_message) {
        if (await isAdmin(chatId, user.id)) {
           const fakeMsg = await bot.sendMessage(chatId, roasts.jhatka_msg);
           setTimeout(async () => {
              await bot.editMessageText(roasts.jhatka_edit, { chat_id: chatId, message_id: fakeMsg.message_id });
           }, 4000);
        }
      }
    } // End Message Handler

    // --- D. GHOST EDIT DETECTOR (Edited Messages) ---
    if (body.edited_message) {
       const msg = body.edited_message;
       // We can only detect edits, not pure deletes via standard API.
       // This logs the edit to the group.
       await bot.sendMessage(msg.chat.id, `📸 **CAUGHT IN 4K!**\n@${msg.from.username} just edited a message.\n*Doghla-pan mat kar!*`);
    }

  } catch (error) {
    console.error(error);
  }

  return { statusCode: 200, body: "OK" };
};