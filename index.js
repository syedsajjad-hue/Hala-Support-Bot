const express = require("express");
const { Telegraf } = require("telegraf");

const app = express();
const PORT = process.env.PORT || 10000;

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing in Render Environment Variables");
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// ---------- Bot commands ----------
bot.start((ctx) => {
  ctx.reply("Bot is working.");
});

bot.help((ctx) => {
  ctx.reply("Send me any message and I will reply.");
});

bot.on("text", async (ctx) => {
  try {
    await ctx.reply(`You said: ${ctx.message.text}`);
  } catch (error) {
    console.error("Reply error:", error);
  }
});

// ---------- Web server ----------
app.get("/", (req, res) => {
  res.status(200).send("Bot server is running");
});

// ---------- Start bot safely ----------
let botStarted = false;

async function startBot() {
  if (botStarted) {
    console.log("Bot already started, skipping duplicate launch.");
    return;
  }

  try {
    // Clear webhook in case Telegram still has old webhook config
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    // Start polling safely
    await bot.launch({ dropPendingUpdates: true });

    botStarted = true;
    console.log("Bot started");
  } catch (error) {
    console.error("Bot launch error:", error);
  }
}

const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await startBot();
});

// ---------- Graceful shutdown ----------
process.once("SIGINT", async () => {
  console.log("SIGINT received. Stopping bot...");
  try {
    bot.stop("SIGINT");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  } catch (error) {
    console.error("Shutdown error:", error);
    process.exit(1);
  }
});

process.once("SIGTERM", async () => {
  console.log("SIGTERM received. Stopping bot...");
  try {
    bot.stop("SIGTERM");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  } catch (error) {
    console.error("Shutdown error:", error);
    process.exit(1);
  }
});
