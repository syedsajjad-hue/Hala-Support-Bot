require('dotenv').config();

const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

bot.use(session());

/* ================= GOOGLE SHEETS ================= */

const sheetsAuth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

async function appendToSheet(ticket) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          ticket.ticket_number,
          new Date().toISOString(),
          ticket.driver_id,
          ticket.disposition,
          ticket.description || '',
          ticket.priority,
          ticket.status,
          ticket.assigned_agent || 'Not Assigned',
          ticket.telegram_user_id,
          ticket.photo_file_id || '',
          ticket.id,
          ''
        ]]
      }
    });

    console.log('Sheet updated');
  } catch (err) {
    console.log('Sheet error:', err.message);
  }
}

/* ================= HELPERS ================= */

function isValidMeterId(v) {
  return /^\d{7}$/.test(v);
}

async function getNextTicketNumber() {
  const { data } = await supabase.from('tickets').select('ticket_number');

  let max = 0;

  (data || []).forEach(t => {
    if (t.ticket_number) {
      const num = parseInt(t.ticket_number.split('-')[1]);
      if (num > max) max = num;
    }
  });

  return `HALA-${String(max + 1).padStart(3, '0')}`;
}

/* ================= BOT ================= */

bot.start(ctx => {
  ctx.session = {};
  return ctx.reply(
    'Welcome to Hala Bot',
    Markup.keyboard([['Create Ticket']]).resize()
  );
});

bot.hears('Create Ticket', ctx => {
  ctx.session = { step: 'type' };
  return ctx.reply(
    'Select issue:',
    Markup.keyboard([
      ['Payment Issue', 'Account Block'],
      ['Stuck Booking', 'Device Issue']
    ]).resize()
  );
});

bot.on('text', async ctx => {
  const text = ctx.message.text;

  if (!ctx.session?.step) return;

  if (ctx.session.step === 'type') {
    ctx.session.type = text;
    ctx.session.step = 'meter';
    return ctx.reply('Enter 7-digit Meter ID:');
  }

  if (ctx.session.step === 'meter') {
    if (!isValidMeterId(text)) return ctx.reply('Invalid Meter ID');

    ctx.session.meter = text;
    ctx.session.step = 'desc';
    return ctx.reply('Enter description:');
  }

  if (ctx.session.step === 'desc') {
    ctx.session.desc = text;

    const ticketNumber = await getNextTicketNumber();

    const { data, error } = await supabase
      .from('tickets')
      .insert([{
        ticket_number: ticketNumber,
        telegram_user_id: String(ctx.from.id),
        driver_id: ctx.session.meter,
        disposition: ctx.session.type,
        description: ctx.session.desc,
        priority: 'Medium',
        status: 'Pending'
      }])
      .select()
      .single();

    if (error) return ctx.reply('Error saving ticket');

    await appendToSheet(data);

    ctx.session = {};

    return ctx.reply(`✅ Ticket created: ${ticketNumber}`);
  }
});

/* ================= SERVER ================= */

app.use(bot.webhookCallback('/webhook'));

app.listen(PORT, async () => {
  console.log('Server running');

  await bot.telegram.setWebhook(`${RENDER_URL}/webhook`);
});
