const teeworlds = require("teeworlds");
const Groq = require("groq-sdk");

// ================== КОНФИГ ==================
const config = {
    host: "87.120.186.242",   // IP сервера
    port: 8304,               // порт сервера
    botNick: "AI_Bot",        // имя бота
    groqKey: "API_KEY", // <-- вставь свой ключ
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    maxReplyLength: 250,      // макс длина ответа (ограничение DDNet)
    replyDelay: 1200,         // задержка перед ответом (мс)
    historySize: 150,          // сколько последних сообщений хранить
    temperature: 1.6          // можно подрегулировать
};
// ============================================

// Инициализация Groq
const groq = new Groq({ apiKey: config.groqKey });

// Teeworlds-клиент
const client = new teeworlds.Client(config.host, config.port, config.botNick);

// Системный промт — поведение бота (важно: НЕ просим вставлять "Ник" слово)
const systemPrompt = `
Ты игровой участник в чате DDNet (русскоязычный). Отвечай как реальный игрок, кратко и по делу.
Не раскрывай, что ты модель/ИИ, по скольку ты человек 12 лет (зимпа). Не добавляй в ответ префиксы вроде "Ник:" или "[''/]:" — возвращай только текст ответа.
Можешь подстраиваться под стиль чата, включая и грубость, если собеседник агрессивен.
Если следует — используй ненормативную лексику в стиле игрового чата.
Отвечай только на заданный вопрос игрока; не пересказывай весь чат.
Используй русский язык, и не смей повторять свои прошлые ответы даже если собеседник повторяет!.
Ты довольно сам по себе добрый и разговорчевый человек, добрый, дружелюбный ко всем и любит поболтать`;

// История чата (максимум config.historySize сообщений)
// будем хранить объекты { author: "Nick", text: "Сообщение" }
const chatHistory = [];

// Подключение
client.connect();

client.on("connected", () => {
    console.log(`✅ Бот ${config.botNick} подключен к ${config.host}:${config.port}`);
});

client.on("disconnect", (reason) => {
    console.log(`❌ Бот отключен: ${reason}`);
});

// Вспомогательная: добавить запись в историю и обрезать до historySize
function pushToHistory(author, text) {
    chatHistory.push({ author, text });
    if (chatHistory.length > config.historySize) chatHistory.shift();
}

// Слушаем весь чат -> сохраняем и реагируем при упоминании ника бота
client.on("message", async (msg) => {
    try {
        if (typeof msg.message !== "string" || !msg.author?.ClientInfo?.name) return;
        const rawText = msg.message;
        const text = rawText.trim();
        const author = msg.author.ClientInfo.name;

        // ignore bot itself
        if (author === config.botNick) return;

        // сохраняем сообщение в историю (включая все реплики игроков)
        pushToHistory(author, text);

        // если в сообщении упомянуто имя бота (регистронезависимо), отвечаем
        if (text.toLowerCase().includes(config.botNick.toLowerCase())) {
            console.log(`[PING] ${author}: ${text}`);

            // удаляем упоминание бота из самого текста (если нужно)
            const promptText = text.replace(new RegExp(config.botNick, "ig"), "").trim() || "Привет!";

            // собираем контекст — последние N сообщений (вместе с никнеймами)
            const historyContext = chatHistory
                .slice(-config.historySize)
                .map(m => `[${m.author}]: ${m.text}`)
                .join("\n");

            // Составляем сообщения для модели:
            //  - system (правила поведения)
            //  - user (контекст + текущий вопрос)
            const messages = [
                { role: "system", content: systemPrompt },
                {
                    role: "user",
                    content:
`Контекст (последние ${Math.min(chatHistory.length, config.historySize)} сообщений):
${historyContext}

Сейчас игрок [${author}] пишет: ${promptText}

Инструкция: ответь КРАТКО, по делу и по возможности в стиле игрового чата. 
НЕ добавляй имя игрока или любые префиксы в ответ — верни ТОЛЬКО текст ответа.`
                }
            ];

            // Запрос к Groq
            let aiText = "";
            try {
                const completion = await groq.chat.completions.create({
                    model: config.model,
                    messages: messages,
                    temperature: config.temperature,
                    max_tokens: 256,
                    top_p: 1,
                    stream: false
                });
                aiText = (completion.choices?.[0]?.message?.content || "").trim();
            } catch (err) {
                console.error("Ошибка при запросе к Groq:", err);
                client.game.Say(`${author}: Ошибка AI (см. консоль).`);
                // добавляем ответ бота в историю
                pushToHistory(config.botNick, `${author}: Ошибка AI`);
                return;
            }

            // Модель должна вернуть чистый текст ответа (без 'Имя:'), но на всякий случай удалим возможные дубликаты префиксов
            // если модель случайно вернула "Имя: ...", уберём начальный "Имя:" или "Nick:" и т.п.
            // удалим конструкцию "<какое-то имя>:" если она стоит в начале и совпадает с author или с botNick
            let cleaned = aiText.replace(/^\s*\[?([^:\]\s]+)\]?\s*:\s*/u, (m, g1) => {
                // если g1 похоже на nick (автора или бот), то убираем, иначе оставляем (на всякий случай)
                const lower = g1.toLowerCase();
                if (lower === author.toLowerCase() || lower === config.botNick.toLowerCase() || lower === "ник") {
                    return "";
                }
                return m; // не трогаем
            }).trim();

            if (!cleaned) cleaned = "...."; // защита на случай пустого ответа

            // Формируем окончательный текст: "Author: ответ"
            const finalMessage = `${author}: ${cleaned}`.slice(0, config.maxReplyLength);

            // Отправляем ответ через некоторое время (replyDelay)
            setTimeout(() => {
                try {
                    client.game.Say(finalMessage);
                } catch (e) {
                    console.error("Ошибка отправки в чат:", e);
                }
            }, config.replyDelay);

            // И обязательно записываем ответ бота в историю, чтобы память учитывала его
            pushToHistory(config.botNick, finalMessage);

            console.log(`[AI -> ${author}] ${finalMessage}`);
        }
    } catch (e) {
        console.error("Ошибка обработки сообщения:", e);
    }
});

// корректное завершение
process.on("SIGINT", async () => {
    console.log("⏹ Выключаем бота...");
    try { await client.Disconnect(); } catch (e) {}
    process.exit(0);
});
