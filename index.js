require('dotenv').config();

const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000';
const WEBHOOK_PATH = '/telegram-webhook';

const bot = new Telegraf(process.env.BOT_TOKEN);

// ================= SESSION =================
bot.use(session());

// ================= MENU =================
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Create Ticket', 'create_ticket')],
    [Markup.button.callback('Profile Update', 'disp_profile_update')]
  ]);
}

// ================= START =================
bot.start((ctx) => {
  ctx.session = {};
  return ctx.reply('Welcome to Hala Support Bot', mainMenu());
});

// ================= PROFILE UPDATE MENU =================
bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    'Select Profile Update Type',
    Markup.inlineKeyboard([
      [Markup.button.callback('Number Update', 'profile_number_update')]
    ])
  );
});

// ================= NUMBER UPDATE FLOW (FIXED) =================
bot.action('profile_number_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    step: 'meter_id_only_for_form'
  };

  return ctx.reply('📟 Enter 7-digit Meter ID:');
});

// ================= TEXT HANDLER =================
bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};

  const text = ctx.message.text;

  // ================= FIXED NUMBER UPDATE FLOW =================
  if (ctx.session.step === 'meter_id_only_for_form') {

    if (!/^\d{7}$/.test(text)) {
      return ctx.reply('❌ Enter valid 7-digit Meter ID');
    }

    const meterId = text;

    ctx.session = {}; // STOP FLOW

    return ctx.reply(
      `📱 Number Update Request\n\nMeter ID: ${meterId}\n\nClick below to proceed:`,
      Markup.inlineKeyboard([
        [
          Markup.button.url(
            '🔗 Open Number Update Form',
            'https://tinyurl.com/2p6spcpb'
          )
        ]
      ])
    );
  }

  return ctx.reply('Please use menu /start');
});

// ================= EXPRESS =================
app.get('/', (req, res) => {
  res.send('Bot running');
});

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  console.log('Bot running on port', PORT);

  await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
});
