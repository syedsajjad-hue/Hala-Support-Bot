require('dotenv').config();
const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const WEBHOOK_PATH = '/telegram-webhook';

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin';

const ALERT_AFTER_MINUTES = 15;
const REPEAT_ALERT_MINUTES = 5;

if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL missing');
if (!process.env.SUPABASE_KEY) throw new Error('SUPABASE_KEY missing');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ================= GOOGLE SHEETS =================
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
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
    [
      Markup.button.callback('Profile Update', 'disp_profile_update')
    ]
  ]);
}

// ================= START =================
bot.start((ctx) => {
  ctx.session = {};
  return ctx.reply('Welcome to Hala Captain Support', mainMenuButtons());
});

// ================= CREATE MENU FIX =================
bot.action('menu_create_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'disposition' };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Select issue type:', issueTypeButtons());
});

// ================= DEVICE ISSUE =================
bot.action('disp_device_issue', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Please Visit Hala Home for Device Issue. Thanks');
});

// ================= PROFILE UPDATE =================
bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    disposition: 'Profile Update',
    step: 'profile_type'
  };

  return ctx.reply('Select type:\n1. Number Update\n2. Profile Picture Update');
});

// ================= NUMBER UPDATE =================
bot.action('profile_number_update', async (ctx) => {
  ctx.session = {
    disposition: 'Profile Update',
    profile_update_type: 'Number Update',
    step: 'meter_id'
  };

  return ctx.reply('Enter Meter ID');
});

// ================= TEXT FLOW =================
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  if (!ctx.session) ctx.session = {};

  // meter ID
  if (ctx.session.step === 'meter_id') {
    ctx.session.meter_id = text;
    ctx.session.step = 'mobile_number';
    return ctx.reply('Enter Mobile Number');
  }

  // MOBILE NUMBER FIX (IMPORTANT)
  if (ctx.session.step === 'mobile_number') {
    ctx.session.mobile_number = text;
    ctx.session.description = `Number Update: ${text}`;

    await createTicket(ctx);

    const ticket = ctx.session.last_ticket_number;
    const url = `https://tinyurl.com/2p6spcpb?ticket=${ticket}`;

    await ctx.reply(`📌 Number Update Form:\n${url}\n🎫 Ticket: ${ticket}`);

    if (process.env.TEAM_CHAT_ID) {
      await bot.telegram.sendMessage(
        process.env.TEAM_CHAT_ID,
        `Number Update Ticket\n${ticket}\n${url}`
      );
    }

    return;
  }
});

// ================= CREATE TICKET =================
async function createTicket(ctx) {
  const { data } = await supabase
    .from('tickets')
    .insert([
      {
        ticket_number: 'TKT-' + Date.now(),
        disposition: ctx.session.disposition,
        driver_id: ctx.session.meter_id,
        description: ctx.session.description,
        details_json: {
          mobile: ctx.session.mobile_number
        },
        status: 'Pending'
      }
    ])
    .select()
    .single();

  ctx.session.last_ticket_number = data.ticket_number;

  return data;
}

// ================= SERVER =================
app.get('/', (req, res) => res.send('Bot Running'));

app.listen(PORT, async () => {
  console.log('Server running');

  await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
});

app.use(bot.webhookCallback(WEBHOOK_PATH));
