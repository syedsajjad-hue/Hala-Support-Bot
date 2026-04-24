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

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ================= SHEETS =================
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

bot.use(session());

// ================= MENU =================
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Create Ticket', 'create')],
    [Markup.button.callback('Check Ticket', 'check')]
  ]);
}

// ================= START =================
bot.start((ctx) => {
  ctx.session = {};
  return ctx.reply('Welcome to Hala Captain Support', mainMenu());
});

// ================= CREATE MENU =================
bot.action('create', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'meter_id' };
  return ctx.reply('Enter 7-digit Meter ID:');
});

// ================= TEAM MESSAGE =================
async function sendToTeam(ticket, ctx) {
  try {
    if (!process.env.TEAM_CHAT_ID) return;

    const msg =
`🆕 New Ticket Created

Ticket: ${ticket.ticket_number}
Type: ${ticket.disposition}
Meter ID: ${ticket.driver_id}
Priority: ${ticket.priority}
Status: Pending`;

    if (ticket.photo_file_id) {
      await bot.telegram.sendPhoto(
        process.env.TEAM_CHAT_ID,
        ticket.photo_file_id,
        {
          caption: msg
        }
      );
    } else {
      await bot.telegram.sendMessage(
        process.env.TEAM_CHAT_ID,
        msg
      );
    }
  } catch (e) {
    console.log('TEAM SEND ERROR:', e.message);
  }
}

// ================= CREATE TICKET =================
async function createTicket(ctx) {
  try {

    // 🔥 FIX 1: Ticket format Hala-001
    const raw = await getNextTicketNumber();
    const ticketNumber = `Hala-${String(raw).padStart(3, '0')}`;

    const { data, error } = await supabase
      .from('tickets')
      .insert([{
        ticket_number: ticketNumber,
        telegram_user_id: String(ctx.from.id),
        driver_id: ctx.session.meter_id,
        disposition: ctx.session.disposition || 'General',
        description: ctx.session.description || '',
        status: 'Pending',
        priority: 'Medium',
        photo_file_id: ctx.session.photo_file_id || null
      }])
      .select()
      .single();

    if (error) {
      console.log(error);
      return ctx.reply('DB error');
    }

    // 🔥 FIX 2: ALWAYS SEND TO TEAM
    await sendToTeam(data, ctx);

    ctx.session = {};

    return ctx.reply(
`✅ Ticket Created
Ticket: ${ticketNumber}`
    );

  } catch (e) {
    console.log(e);
    return ctx.reply('Error creating ticket');
  }
}

// ================= METER ID =================
bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const text = ctx.message.text;

  if (ctx.session.step === 'meter_id') {
    if (!/^\d{7}$/.test(text)) {
      return ctx.reply('Invalid Meter ID');
    }

    ctx.session.meter_id = text;

    return createTicket(ctx);
  }
});

// ================= TICKET NUMBER GENERATOR =================
async function getNextTicketNumber() {
  const { data, error } = await supabase.rpc('generate_hala_ticket_number');

  if (error) throw error;

  return data;
}

// ================= WEBHOOK =================
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  console.log('Bot running');

  await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
});
