const teeworlds = require("teeworlds");
const Groq = require("groq-sdk");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

// ----------------- ANSI COLORS -----------------
const C = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m"
};
function col(color, text) { return (color || "") + text + C.reset; }

// ----------------- Files & Config -----------------
const CONFIG_FILE = path.join(__dirname, "config.json");
const ADMINS_FILE = path.join(__dirname, "admins.json");

const defaultConfig = {
  host: "87.120.186.242",
  port: 8304,
  botNick: "AI_bot",
  ownerNick: "Mouse Tee(3050)",
  groqKey: "",
  model: "meta-llama/llama-4-scout-17b-16e-instruct",
  maxReplyLength: 250,
  replyDelay: 1200,
  temperature: 1.0,
  prefix: "#",
  historySize: 150,
  language: "ru",
  systemPrompt: null,
  autoTeam: null
};

let config = Object.assign({}, defaultConfig);
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    config = Object.assign({}, defaultConfig, parsed || {});
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
  }
} catch (e) {
  console.warn("Config load error, using defaults:", e);
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.warn("Could not save config.json:", e); }
}

// ----------------- State -----------------
let client = null;
let botActive = true;
let admins = new Set();
let chatHistory = [];
let pendingApproval = null; // { requester, command, args, timerId }
let reconnecting = false;
let nickChanging = false;
let aiDisabledDueToKey = false;

// load admins
try {
  if (fs.existsSync(ADMINS_FILE)) {
    const raw = fs.readFileSync(ADMINS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) admins = new Set(arr);
  } else {
    fs.writeFileSync(ADMINS_FILE, JSON.stringify([], null, 2));
  }
} catch (e) {
  console.warn("admins load error:", e);
}
function saveAdmins() {
  try { fs.writeFileSync(ADMINS_FILE, JSON.stringify([...admins], null, 2)); }
  catch (e) { console.warn("Could not save admins.json:", e); }
}

// ----------------- Utils -----------------
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
function normalizeNick(s) { return (s || "").toLowerCase().trim(); }
function isOwner(nick) { return normalizeNick(nick) === normalizeNick(config.ownerNick); }
function isAdmin(nick) {
  if (!nick) return false;
  if (isOwner(nick)) return true;
  const n = normalizeNick(nick);
  for (const a of admins) if (normalizeNick(a) === n) return true;
  return false;
}
function pushToHistory(author, text) {
  chatHistory.push({ author, text });
  if (chatHistory.length > config.historySize) chatHistory.shift();
}

// ----------------- Translations -----------------
const T = {
  ru: {
    connectedTo: (h, p) => `✅ Бот подключен к серверу ${h}:${p}`,
    joined: "Бот зашёл на сервер",
    rejoined: "✅ Бот перезашёл!",
    nickChanged: n => `✅ Ник сменён на ${n}`,
    nickChanging: n => `🔄 Смена ника на ${n}...`,
    leaving: "Бот вышел с сервера",
    accessDenied: "Доступ запрещён",
    botOn: "✅ Бот включён",
    botOff: "🛑 Бот выключен",
    prefixSet: p => `🔧 Новый префикс: ${p}`,
    delaySet: ms => `✅ Задержка ответов установлена: ${ms} мс`,
    help: nick => `/w ${nick} 📜 Команды: #help, #bot on/off, #prefix <символ>, #replydelay <мс>, #addadmin "ник", #deladmin "ник", #admins, #setprompt <текст>, #setnick "ник", #rejoin, #exit, #setlang ru/en, #team <id>`,
    adminAdded: n => `✅ ${n} теперь админ`,
    adminRemoved: n => `❌ ${n} больше не админ`,
    adminsList: a => (a.size ? `👥 Админы: ${[...a].join(", ")}` : "👥 Админов пока нет"),
    promptUpdated: "✅ Промпт обновлён",
    awaitingApproval: (a, c, args) => `⚠️ Подтвердите команду от ${a}: #${c} ${args.join(" ")} — #yes или #no`,
    approved: u => `✅ Команда от ${u} подтверждена владельцем.`,
    denied: u => `❌ Команда от ${u} отклонена владельцем.`,
    noPending: "❌ Нет команд на подтверждение.",
    unknown: nick => `${nick}: неизвестная команда`,
    languageChanged: l => `✅ Язык переключен на ${l === "ru" ? "русский" : "английский"}`,
    invalidGroqKey: "❌ Неверный Groq API key — проверьте config.groqKey",
    teamJoined: id => `✅ Бот зашёл в команду ${id}`
  },
  en: {
    connectedTo: (h, p) => `✅ Bot connected to ${h}:${p}`,
    joined: "Bot joined the server",
    rejoined: "✅ Bot rejoined!",
    reconnecting: "🔄 Bot reconnecting...",
    nickChanged: n => `✅ Nick changed to ${n}`,
    nickChanging: n => `🔄 Changing nick to ${n}...`,
    leaving: "Bot left the server",
    accessDenied: "Access denied",
    botOn: "✅ Bot enabled",
    botOff: "🛑 Bot disabled",
    prefixSet: p => `🔧 New prefix: ${p}`,
    delaySet: ms => `✅ Reply delay set to ${ms} ms`,
    help: nick => `/w ${nick} 📜 Commands: #help, #bot on/off, #prefix <symbol>, #replydelay <ms>, #addadmin "name", #deladmin "name", #admins, #setprompt <text>, #setnick "name", #rejoin, #exit, #setlang ru/en, #team <id>`,
    adminAdded: n => `✅ ${n} is now an admin`,
    adminRemoved: n => `❌ ${n} is no longer an admin`,
    adminsList: a => (a.size ? `👥 Admins: ${[...a].join(", ")}` : "👥 No admins yet"),
    promptUpdated: "✅ System prompt updated",
    awaitingApproval: (a, c, args) => `⚠️ Awaiting approval from ${a}: #${c} ${args.join(" ")} — #yes or #no`,
    approved: u => `✅ Command from ${u} approved by owner.`,
    denied: u => `❌ Command from ${u} denied by owner.`,
    noPending: "❌ No pending commands.",
    unknown: nick => `${nick}: Unknown command`,
    languageChanged: l => `✅ Language set to ${l === "ru" ? "Russian" : "English"}`,
    invalidGroqKey: "❌ Invalid Groq API key — check config.groqKey",
    teamJoined: id => `✅ Joined team ${id}`
  }
};
function t(key, ...args) {
  const dict = (config.language === "ru") ? T.ru : T.en;
  const v = dict[key];
  return (typeof v === "function") ? v(...args) : v;
}

// ----------------- Safe senders -----------------
function safeSay(text) {
  try {
    if (client && client.game && typeof client.game.Say === "function") {
      client.game.Say(String(text));
      return true;
    }
  } catch (e) {
    console.warn("safeSay failed:", e);
  }
  return false;
}
function safeWhisper(to, text) {
  try {
    if (!client || !client.game) return false;
    if (typeof client.game.Whisper === "function") {
      client.game.Whisper(to, String(text));
      return true;
    }
    if (typeof client.game.Say === "function") {
      try {
        client.game.Say(String(text));
        return true;
      } catch (e) {
        client.game.Say(`/w ${to} ${String(text)}`);
        return true;
      }
    }
  } catch (e) {
    console.warn("safeWhisper failed:", e);
  }
  return false;
}
function safeTeam(id) {
  try {
    if (client && client.game && typeof client.game.Say === "function") {
      client.game.Say(`/team ${id}`);
      return true;
    }
  } catch (e) {
    console.warn("safeTeam failed:", e);
  }
  return false;
}

// ----------------- Console log helpers -----------------
function logSystem(msg) { console.log(col(C.gray, `[system] ${msg}`)); }
function logTagged(author, text) { console.log(col(C.red, `[tagged] [${author}] > ${text}`)); }
function logWhisper(author, text) { console.log(col(C.magenta, `[whisper] [${author}] > ${text}`)); }
function logAiReply(player, text, whisper=false) {
  if (whisper) console.log(col(C.blue, `[AI -> ${player}] (whisper): ${text}`));
  else console.log(col(C.green, `[AI -> ${player}]: ${text}`));
}

// ----------------- Create client -----------------
function createClient() {
  try {
    client = new teeworlds.Client(config.host, config.port, config.botNick);
  } catch (e) {
    console.error("Failed to create teeworlds client:", e);
    process.exit(1);
  }

  client.on("connected", () => {
    logSystem(t("connectedTo", config.host, config.port));

    let msg = "";
    if (reconnecting && nickChanging) {
      msg = config.language === "ru"
        ? `✅ Бот перезашёл, ник сменён на ${config.botNick}`
        : `✅ Bot rejoined, nick changed to ${config.botNick}`;
    } else if (nickChanging) {
      msg = t("nickChanged", config.botNick);
    } else if (reconnecting) {
      msg = t("rejoined");
    } else {
      msg = t("joined");
    }

    try { safeSay(msg); } catch (e) {}
    logSystem(msg);

    // auto team on connect
    if (config.autoTeam) {
      try {
        const ok = safeTeam(config.autoTeam);
        if (ok) safeSay(t("teamJoined", config.autoTeam));
      } catch (e) {}
    }

    nickChanging = false;
    reconnecting = false;
  });

  client.on("disconnect", reason => {
    logSystem(`Disconnected: ${reason}`);
  });

  client.on("error", err => {
    console.error("Client error:", err);
  });

  client.on("message", async (msg) => {
    try {
      if (typeof msg.message !== "string" || !msg.author?.ClientInfo?.name) return;
      const author = msg.author.ClientInfo.name;
      const raw = msg.message.trim();
      if (author === config.botNick) return;

      // detect whisper
      let isWhisper = false;
      let whisperText = raw;
      if (msg.mode === "whisper" || msg.whisper) {
        isWhisper = true;
      } else {
        const m = raw.match(/^\/w\s+("([^"]+)"|(\S+))\s+([\s\S]+)/i);
        if (m) {
          const target = (m[2] || m[3] || "").replace(/^"|"$/g, "");
          if (normalizeNick(target) === normalizeNick(config.botNick)) {
            isWhisper = true;
            whisperText = m[4] || "";
          }
        }
      }

      const isMention = !isWhisper && raw.toLowerCase().includes(config.botNick.toLowerCase());

      // logs
      if (isWhisper) logWhisper(author, whisperText);
      else if (isMention) logTagged(author, raw);

      pushToHistory(author, raw);

      // command parsing (use whisper text if whisper)
      const rawCommand = (isWhisper ? whisperText : raw);
      if (rawCommand.startsWith(config.prefix)) {
        const parts = rawCommand.slice(config.prefix.length).trim().match(/("[^"]+"|\S+)/g) || [];
        const command = (parts[0] || "").toLowerCase().replace(/(^"|"$)/g, "");
        const args = parts.slice(1).map(p => p.replace(/^"|"$/g, ""));
        await handleCommand(command, args, author);
        return;
      }

      // only reply when mentioned or whispered
      if (!botActive && !isWhisper) return;
      if (!isMention && !isWhisper) return;

      // prepare prompt
      const promptText = (isWhisper ? whisperText : raw.replace(new RegExp(config.botNick, "ig"), "")).trim() || (config.language === "ru" ? "Привет!" : "Hi!");
      const historyContext = chatHistory.map(m => `[${m.author}]: ${m.text}`).join("\n");

      if (aiDisabledDueToKey) {
        const warn = config.language === "ru" ? "AI отключён (неверный Groq ключ)" : "AI disabled (invalid Groq key)";
        if (isWhisper) { safeWhisper(author, warn); logAiReply(author, warn, true); }
        else { safeSay(`${author}: ${warn}`); logAiReply(author, warn, false); }
        return;
      }

      try {
        const groq = new Groq({ apiKey: config.groqKey });
        const completion = await groq.chat.completions.create({
          model: config.model,
          messages: [
            { role: "system", content: config.systemPrompt || (config.language === "ru" ? "Ты игрок в чате DDNet. Отвечай дружелюбно, коротко." : "You are a player in DDNet chat. Respond briefly and friendly.") },
            { role: "user", content: `Context:\n${historyContext}\nPlayer [${author}]: ${promptText}` }
          ],
          temperature: config.temperature,
          max_tokens: 256
        });

        const aiText = (completion.choices?.[0]?.message?.content || "").trim().slice(0, config.maxReplyLength);

        setTimeout(() => {
          try {
            if (isWhisper) {
              safeWhisper(author, aiText);
              logAiReply(author, aiText, true);
            } else {
              safeSay(`${author}: ${aiText}`);
              logAiReply(author, aiText, false);
            }
            pushToHistory(config.botNick, aiText);
          } catch (e) {
            console.error("Error sending AI reply:", e);
          }
        }, Math.max(0, config.replyDelay));
      } catch (err) {
        const status = err?.status || err?.error?.status;
        const message = err?.error?.message || err?.message || String(err || "");
        if (status === 401 || /invalid api key/i.test(String(message))) {
          console.error(t("invalidGroqKey"));
          aiDisabledDueToKey = true;
        } else {
          console.error("AI error:", err);
        }
      }
    } catch (e) {
      console.error("Message handler error:", e);
    }
  });

  client.connect();
}

// ----------------- Command handler -----------------
async function handleCommand(command, args, author, isConsole = false) {
  if (!command) return;
  const owner = isConsole || isOwner(author);
  const admin = owner || isAdmin(author);

  // help (everyone) — send privately
  if (command === "help") {
    try { safeWhisper(author, t("help", author)); } catch (e) { console.warn("Help send failed:", e); }
    return;
  }

  // owner confirmation (#yes/#no)
  if (owner && (command === "yes" || command === "no") && pendingApproval) {
    const p = pendingApproval;
    clearPending();
    if (command === "yes") {
      safeSay(t("approved", p.requester));
      await handleCommand(p.command, p.args, p.requester, true);
    } else {
      safeSay(t("denied", p.requester));
    }
    return;
  }

  // admin (not owner) -> create pending approval
  if (!owner && isAdmin(author) && !pendingApproval && command !== "help") {
    pendingApproval = { requester: author, command, args, timerId: null };
    pendingApproval.timerId = setTimeout(() => {
      if (pendingApproval && pendingApproval.requester === author) {
        safeSay(`${pendingApproval.requester}: ${config.language === "ru" ? "⌛ Запрос не подтверждён и отменён." : "⌛ Request not confirmed and canceled."}`);
        pendingApproval = null;
      }
    }, 30_000);
    safeSay(t("awaitingApproval", author, command, args));
    return;
  }

  // not admin and not owner -> deny
  if (!owner && !isAdmin(author)) {
    safeSay(`${author}: ❌ ${t("accessDenied")}`);
    return;
  }

  // owner / console execute:
  switch (command) {
    case "bot": {
      if (!args[0]) return safeSay(config.language === "ru" ? "Usage: #bot on/off" : "Usage: #bot on/off");
      if (args[0] === "on") { botActive = true; safeSay(t("botOn")); }
      else if (args[0] === "off") { botActive = false; safeSay(t("botOff")); }
      break;
    }

    case "prefix": {
      if (!admin) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      if (!args[0]) return safeSay(config.language === "ru" ? "Usage: #prefix <символ>" : "Usage: #prefix <symbol>");
      config.prefix = args[0];
      saveConfig();
      safeSay(t("prefixSet", config.prefix));
      break;
    }

    case "replydelay": {
      if (!admin) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      const v = parseInt(args[0]);
      if (isNaN(v) || v < 0) return safeSay(config.language === "ru" ? "Usage: #replydelay <мс>" : "Usage: #replydelay <ms>");
      config.replyDelay = v;
      saveConfig();
      safeSay(t("delaySet", v));
      break;
    }

    case "addadmin": {
      if (!owner) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      const nick = args.join(" ").replace(/"/g, "").trim();
      if (!nick) return safeSay(config.language === "ru" ? 'Usage: #addadmin "ник"' : 'Usage: #addadmin "name"');
      admins.add(nick);
      saveAdmins();
      safeSay(t("adminAdded", nick));
      break;
    }

    case "deladmin": {
      if (!owner) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      const nick = args.join(" ").replace(/"/g, "").trim();
      if (!nick) return safeSay(config.language === "ru" ? 'Usage: #deladmin "ник"' : 'Usage: #deladmin "name"');
      for (const a of [...admins]) if (normalizeNick(a) === normalizeNick(nick)) admins.delete(a);
      saveAdmins();
      safeSay(t("adminRemoved", nick));
      break;
    }

    case "admins": {
      safeSay(t("adminsList", admins));
      break;
    }

    case "setprompt": {
      if (!admin) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      if (!args.length) return safeSay(config.language === "ru" ? 'Usage: #setprompt "<text>"' : 'Usage: #setprompt "<text>"');
      config.systemPrompt = args.join(" ");
      saveConfig();
      safeSay(t("promptUpdated"));
      break;
    }

    case "setnick": {
      if (!admin) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      const newNick = args.join(" ").replace(/"/g, "").trim();
      if (!newNick) return safeSay(config.language === "ru" ? 'Usage: #setnick "nick"' : 'Usage: #setnick "nick"');

      // first tell about changing nick
      safeSay(t("nickChanging", newNick));
      logSystem(`Changing nick to ${newNick}`);

      nickChanging = true;
      config.botNick = newNick;
      saveConfig();

      await delay(800);
      await safeDisconnectClient();
      createClient();
      break;
    }

    case "rejoin": {
      if (!admin) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      safeSay(config.language === "ru" ? "🔄 Перезаход..." : t("reconnecting"));
      reconnecting = true;
      await delay(800);
      await safeDisconnectClient();
      createClient();
      break;
    }

    case "exit": {
      if (!owner) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      safeSay(t("leaving"));
      await delay(500);
      await safeDisconnectClient();
      process.exit(0);
      break;
    }

    case "setlang": {
      if (!admin) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      const code = (args[0] || "").toLowerCase();
      if (code !== "ru" && code !== "en") return safeSay(config.language === "ru" ? 'Usage: #setlang ru/en' : 'Usage: #setlang ru/en');
      config.language = code;
      saveConfig();
      safeSay(t("languageChanged", code));
      break;
    }

    case "team": {
      if (!admin) return safeSay(`${author}: ❌ ${t("accessDenied")}`);
      const id = args[0];
      if (!id) return safeSay(config.language === "ru" ? 'Usage: #team <id>' : 'Usage: #team <id>');
      const ok = safeTeam(id);
      if (ok) safeSay(t("teamJoined", id));
      else safeSay(config.language === "ru" ? '❌ Не удалось зайти в команду.' : '❌ Could not join team.');
      break;
    }

    default:
      safeSay(`${author}: ${t("unknown", author)}`);
      break;
  }
}

// ----------------- clear pending -----------------
function clearPending() {
  if (!pendingApproval) return;
  try { if (pendingApproval.timerId) clearTimeout(pendingApproval.timerId); } catch (e) {}
  pendingApproval = null;
}

// ----------------- safe disconnect -----------------
async function safeDisconnectClient() {
  if (!client) return;
  try { if (typeof client.Disconnect === "function") await client.Disconnect(); } catch (e) { console.warn("Disconnect error:", e); }
  try { client.removeAllListeners(); } catch (e) {}
  client = null;
}

// ----------------- start -----------------
createClient();

// ----------------- CLI -----------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", async (input) => {
  if (!input) return;
  try {
    if (input.startsWith(config.prefix)) {
      const parts = input.slice(config.prefix.length).trim().match(/("[^"]+"|\S+)/g) || [];
      const command = (parts[0] || "").toLowerCase().replace(/(^"|"$)/g, "");
      const args = parts.slice(1).map(p => p.replace(/^"|"$/g, ""));
      await handleCommand(command, args, "console", true);
    } else {
      try { client && client.game && client.game.Say(input); } catch (e) { console.warn("Console send failed:", e); }
    }
  } catch (e) {
    console.error("Console error:", e);
  }
});

process.on("SIGINT", async () => {
  logSystem("Shutting down...");
  try { safeSay(config.language === "ru" ? "Бот вышел с сервера" : "Bot left the server"); } catch (e) {}
  await safeDisconnectClient();
  process.exit(0);
});
