require('dotenv').config();
const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://hala-support-bot.onrender.com';
const WEBHOOK_PATH = '/telegram-webhook';

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin';

const ALERT_AFTER_MINUTES = 15;
const REPEAT_ALERT_MINUTES = 5;

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is missing');
if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is missing');
if (!process.env.SUPABASE_KEY) throw new Error('SUPABASE_KEY is missing');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ================= GOOGLE SHEETS =================
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY
      ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

// ================= SESSION =================
bot.use(session());

// ================= MENUS =================
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
    [Markup.button.callback('Profile Update', 'disp_profile_update')],
    [
      Markup.button.callback('Back', 'nav_back_main'),
      Markup.button.callback('Cancel', 'nav_cancel')
    ]
  ]);
}

function profileUpdateButtons() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Number Update', 'profile_number_update'),
      Markup.button.callback('Profile Picture Update', 'profile_picture_update')
    ],
    [
      Markup.button.callback('Back', 'menu_create_ticket'),
      Markup.button.callback('Cancel', 'nav_cancel')
    ]
  ]);
}

// ================= HELPERS =================
function isValidMeterId(value) {
  return /^\d{7}$/.test(String(value || '').trim());
}

function sanitizeText(value) {
  return String(value || '').trim();
}

function isValidMobileNumber(value) {
  return /^[0-9+\-\s]{7,20}$/.test(String(value || '').trim());
}

async function sendMainMenu(ctx, text = 'Welcome to Hala Captain Support Bot') {
  ctx.session = {};
  return ctx.reply(text, mainMenuButtons());
}

// ================= START =================
bot.start(async (ctx) => sendMainMenu(ctx));

// ================= MENU =================
bot.action('menu_create_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'disposition' };
  return ctx.editMessageText('Select issue type:', issueTypeButtons());
});

bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { disposition: 'Profile Update', step: 'profile_update_type' };
  return ctx.editMessageText('Select profile update type:', profileUpdateButtons());
});

// ================= PROFILE UPDATE =================
bot.action('profile_number_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    profile_update_type: 'Number Update',
    step: 'meter_id'
  };
  await ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('profile_picture_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    profile_update_type: 'Profile Picture Update',
    step: 'meter_id'
  };
  await ctx.reply('Enter 7-digit Meter ID:');
});

// ================= TEXT FLOW =================
bot.on('text', async (ctx) => {
  try {
    if (!ctx.session) ctx.session = {};
    const text = sanitizeText(ctx.message.text);

    // ================= METER ID =================
    if (ctx.session.step === 'meter_id') {

      if (!isValidMeterId(text)) {
        return ctx.reply('Enter valid 7 digit Meter ID');
      }

      ctx.session.meter_id = text;

      // ================= NUMBER UPDATE FIX =================
      if (
        ctx.session.disposition === 'Profile Update' &&
        ctx.session.profile_update_type === 'Number Update'
      ) {
        ctx.session.mobile_number = text;

        ctx.session.description =
          `Profile Update - Number Update\nMeter ID: ${text}`;

        // 🔥 IMPORTANT FIX MESSAGE
        await ctx.reply(
          '📲 Please click on the link to update number:\nhttps://tinyurl.com/2p6spcpb'
        );

        return createTicket(ctx);
      }

      // PROFILE PICTURE FLOW
      if (
        ctx.session.disposition === 'Profile Update' &&
        ctx.session.profile_update_type === 'Profile Picture Update'
      ) {
        ctx.session.step = 'awaiting_profile_picture';
        return ctx.reply('Upload picture with white background and uniform.');
      }

      return createTicket(ctx);
    }

    // ================= DESCRIPTION =================
    if (ctx.session.step === 'description') {
      ctx.session.description = text;
      return createTicket(ctx);
    }

  } catch (err) {
    console.log(err);
    ctx.session = {};
    return ctx.reply('Error occurred. Send /start again.');
  }
});

// ================= CREATE TICKET =================
async function createTicket(ctx) {
  const ticketNumber = Math.floor(100000 + Math.random() * 900000);

  const { data, error } = await supabase
    .from('tickets')
    .insert([{
      ticket_number: ticketNumber,
      telegram_user_id: String(ctx.from.id),
      driver_id: ctx.session.meter_id,
      disposition: ctx.session.disposition,
      description: ctx.session.description || '',
      details_json: {},
      status: 'Pending',
      priority: 'Medium'
    }])
    .select()
    .single();

  if (error) {
    console.log(error);
    return ctx.reply('Database error');
  }

  await ctx.reply(`Ticket created: ${ticketNumber}`);
  ctx.session = {};
}

// ================= SERVER =================
app.get('/', (req, res) => res.send('Bot running'));

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  console.log('Server running');

  await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
});
