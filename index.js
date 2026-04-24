require('dotenv').config();
const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const WEBHOOK_PATH = '/telegram-webhook';

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

bot.use(session({
  defaultSession: () => ({})
}));

/* ================= MAIN MENU ================= */

function mainMenuButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Create Ticket', 'menu_create_ticket')],
    [Markup.button.callback('Check Ticket Status', 'menu_check_status')]
  ]);
}

function issueTypeButtons() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Payment Issue', 'disp_payment'),
      Markup.button.callback('Account Block', 'disp_account_block')
    ],
    [
      Markup.button.callback('Stuck Booking', 'disp_stuck_booking'),
      Markup.button.callback('Device Issue', 'disp_device_issue')
    ],
    [
      Markup.button.callback('Profile Update', 'disp_profile_update')
    ],
    [
      Markup.button.callback('Back', 'nav_back_main')
    ]
  ]);
}

/* ================= START ================= */

bot.start(async (ctx) => {
  ctx.session = {};
  return ctx.reply(
    'Welcome to Hala Captain Support',
    mainMenuButtons()
  );
});

/* ================= MENU ================= */

bot.action('menu_create_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'disposition' };
  return ctx.editMessageText('Select issue type:', issueTypeButtons());
});

bot.action('nav_back_main', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.editMessageText(
    'Welcome to Hala Captain Support',
    mainMenuButtons()
  );
});

/* ================= DISPOSITIONS ================= */

bot.action('disp_payment', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    disposition: 'Payment Issue',
    step: 'meter_id'
  };
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_stuck_booking', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    disposition: 'Stuck Booking',
    step: 'meter_id'
  };
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_device_issue', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.reply('Please visit Hala Home for Device Issue Support.');
});

bot.action('disp_account_block', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.reply('Please visit Hala Home for Account Block/Suspend.');
});

/* ================= TEXT FLOW ================= */

bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const text = ctx.message.text;

  /* ---------- METER ID ---------- */
  if (ctx.session.step === 'meter_id') {

    if (!/^\d{7}$/.test(text)) {
      return ctx.reply('Invalid Meter ID. Enter 7 digits only.');
    }

    ctx.session.meter_id = text;
    ctx.session.step = 'fare';

    return ctx.reply('Enter Fare:');
  }

  /* ---------- FARE ---------- */
  if (ctx.session.step === 'fare') {
    ctx.session.fare = text;
    ctx.session.step = 'time';

    return ctx.reply('Enter Time:');
  }

  /* ---------- TIME → PHOTO OPTIONS ---------- */
  if (ctx.session.step === 'time') {
    ctx.session.time = text;
    ctx.session.step = 'photo_option';

    return ctx.reply(
      'Do you want to attach a photo?',
      Markup.inlineKeyboard([
        [Markup.button.callback('📸 Send Photo', 'send_photo')],
        [Markup.button.callback('⏭ Skip Photo', 'skip_photo')]
      ])
    );
  }
});

/* ================= PHOTO OPTIONS ================= */

bot.action('send_photo', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.step = 'awaiting_photo';
  return ctx.reply('Please send the photo 📸');
});

bot.action('skip_photo', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.photo = null;
  return createTicket(ctx);
});

/* ================= PHOTO HANDLER ================= */

bot.on('photo', async (ctx) => {
  if (ctx.session.step === 'awaiting_photo') {
    ctx.session.photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    return createTicket(ctx);
  }
});

/* ================= CREATE TICKET ================= */

async function createTicket(ctx) {
  try {
    const { data, error } = await supabase
      .from('tickets')
      .insert([{
        ticket_number: 'HALA-' + Math.floor(1000 + Math.random() * 9000),
        telegram_user_id: String(ctx.from.id),
        driver_id: ctx.session.meter_id,
        disposition: ctx.session.disposition,
        description: ctx.session.description || '',
        fare: ctx.session.fare,
        time: ctx.session.time,
        photo: ctx.session.photo || null,
        status: 'Pending',
        priority: 'Medium'
      }])
      .select()
      .single();

    if (error) throw error;

    ctx.session = {};

    return ctx.reply(
      `✅ Ticket Created\nTicket: ${data.ticket_number}`
    );

  } catch (err) {
    console.log(err);
    return ctx.reply('Error creating ticket');
  }
}

/* ================= SERVER ================= */

app.get('/', (req, res) => res.send('Running'));

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(RENDER_URL + WEBHOOK_PATH);
  console.log('Bot running');
});
