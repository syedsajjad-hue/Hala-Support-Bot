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

bot.use(session({ defaultSession: () => ({}) }));

/* ================= BUTTONS ================= */

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

function photoButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📸 Send Photo', 'send_photo')],
    [Markup.button.callback('⏭ Skip Photo', 'skip_photo')]
  ]);
}

function queueButtons(ticket) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('👤 Assign to Me', `assign_${ticket}`),
      Markup.button.callback('✅ Resolve', `resolve_${ticket}`)
    ]
  ]);
}

/* ================= START ================= */

bot.start(ctx => {
  ctx.session = {};
  ctx.reply('Welcome to Hala Captain Support', mainMenuButtons());
});

/* ================= CREATE FLOW ================= */

bot.action('menu_create_ticket', ctx =>
  ctx.editMessageText('Select issue type:', issueTypeButtons())
);

bot.action('disp_payment', ctx => {
  ctx.session = { disposition: 'Payment Issue', step: 'meter' };
  ctx.reply('Enter Meter ID');
});

bot.on('text', async ctx => {

  const s = ctx.session;

  if (s.step === 'meter') {
    s.meter = ctx.message.text;
    s.step = 'fare';
    return ctx.reply('Enter Fare');
  }

  if (s.step === 'fare') {
    s.fare = ctx.message.text;
    s.step = 'time';
    return ctx.reply('Enter Time');
  }

  if (s.step === 'time') {
    s.time = ctx.message.text;
    s.step = 'photo';
    return ctx.reply('Do you want to attach a photo?', photoButtons());
  }

});

/* ================= PHOTO ================= */

bot.action('send_photo', ctx => {
  ctx.session.step = 'awaiting_photo';
  ctx.reply('Send photo now');
});

bot.action('skip_photo', ctx => createTicket(ctx));

bot.on('photo', ctx => {
  ctx.session.photo = ctx.message.photo.pop().file_id;
  createTicket(ctx);
});

/* ================= SAFE TICKET NUMBER ================= */

async function generateTicketNumber() {

  const { data } = await supabase
    .from('tickets')
    .select('ticket_number')
    .like('ticket_number', 'HALA-%');

  let max = 0;

  for (const row of data || []) {
    const match = row.ticket_number.match(/HALA-(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      if (num > max) max = num;
    }
  }

  return `HALA-${String(max + 1).padStart(3,'0')}`;
}

/* ================= SEND TO GROUP ================= */

async function sendToGroup(ctx, ticket) {

  const msg =
`🟡 Ticket Pending

Ticket: ${ticket.ticket_number}
Type: ${ticket.disposition}
Meter ID: ${ticket.driver_id}
Fare: ${ticket.fare || '-'}
Time: ${ticket.time || '-'}
Priority: Medium
Assigned: Unassigned`;

  if (ctx.session.photo) {

    await bot.telegram.sendPhoto(
      process.env.TEAM_CHAT_ID,
      ctx.session.photo,
      {
        caption: msg,
        reply_markup: queueButtons(ticket.ticket_number).reply_markup
      }
    );

  } else {

    await bot.telegram.sendMessage(
      process.env.TEAM_CHAT_ID,
      msg,
      queueButtons(ticket.ticket_number)
    );

  }

}

/* ================= CREATE TICKET ================= */

async function createTicket(ctx) {

  try {

    const ticketNumber = await generateTicketNumber();

    const { data } = await supabase
      .from('tickets')
      .insert([{
        ticket_number: ticketNumber,
        telegram_user_id: ctx.from.id,
        driver_id: ctx.session.meter,
        disposition: ctx.session.disposition,
        fare: ctx.session.fare,
        time: ctx.session.time,
        assigned_to: 'Unassigned',
        status: 'Pending'
      }])
      .select()
      .single();

    await sendToGroup(ctx, data);

    ctx.session = {};

    ctx.reply(`✅ Ticket Created\nTicket: ${ticketNumber}`);

  } catch(err) {

    console.log(err);
    ctx.reply('Error creating ticket');

  }

}

/* ================= ASSIGN ================= */

bot.action(/assign_(.+)/, async ctx => {

  const ticket = ctx.match[1];
  const agent = ctx.from.username || ctx.from.first_name;

  await supabase
    .from('tickets')
    .update({ assigned_to: agent })
    .eq('ticket_number', ticket);

  ctx.answerCbQuery('Assigned');

});

/* ================= RESOLVE ================= */

bot.action(/resolve_(.+)/, async ctx => {

  const ticket = ctx.match[1];

  const { data } = await supabase
    .from('tickets')
    .update({ status:'Resolved' })
    .eq('ticket_number', ticket)
    .select()
    .single();

  await ctx.editMessageCaption?.(
`🟢 Ticket Resolved

Ticket: ${ticket}
Assigned: ${data.assigned_to}
Status: Resolved`
  );

  await bot.telegram.sendMessage(
    data.telegram_user_id,
`✅ Your ticket has been resolved

Ticket: ${ticket}`
  );

});

/* ================= SERVER ================= */

app.get('/', (req,res)=>res.send('Running'));

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {

  await bot.telegram.setWebhook(
    `${RENDER_URL}${WEBHOOK_PATH}`
  );

  console.log('Bot running');

});
