require('dotenv').config();

const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://hala-support-bot.onrender.com';
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

function profileUpdateButtons() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Number Update', 'profile_number_update'),
      Markup.button.callback('Profile Picture Update', 'profile_picture_update')
    ]
  ]);
}

function photoButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📸 Send Photo', 'send_photo')],
    [Markup.button.callback('⏭ Skip Photo', 'skip_photo')]
  ]);
}

/* ================= START ================= */

bot.start(ctx => {
  ctx.session = {};
  return ctx.reply('Welcome to Hala Captain Support', mainMenuButtons());
});

/* ================= MENU ================= */

bot.action('menu_create_ticket', ctx => {
  ctx.session = {};
  return ctx.editMessageText('Select issue type:', issueTypeButtons());
});

bot.action('menu_check_status', ctx => {
  ctx.session = { step: 'check_ticket' };
  return ctx.reply('Enter Ticket Number:');
});

/* ================= ISSUE TYPES ================= */

bot.action('disp_payment', ctx => {
  ctx.session = { disposition: 'Payment Issue', step: 'meter_id' };
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_stuck_booking', ctx => {
  ctx.session = { disposition: 'Stuck Booking', step: 'meter_id' };
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_account_block', ctx =>
  ctx.reply('Please visit Hala Home for Account Block/Suspend.')
);

bot.action('disp_device_issue', ctx =>
  ctx.reply('Please visit Hala Home for Device Issue Support.')
);

/* ================= PROFILE UPDATE ================= */

bot.action('disp_profile_update', ctx =>
  ctx.editMessageText('Select Profile Update Type:', profileUpdateButtons())
);

bot.action('profile_number_update', ctx =>
  ctx.reply('Please click on the link. Thanks\n\nhttps://tinyurl.com/2p6spcpb')
);

bot.action('profile_picture_update', ctx => {
  ctx.session = {
    disposition: 'Profile Update',
    step: 'awaiting_profile_picture'
  };
  return ctx.reply('Upload Profile Picture (White Background & Uniform)');
});

/* ================= TEXT FLOW ================= */

bot.on('text', async ctx => {

  const text = ctx.message.text;

  if (ctx.session.step === 'meter_id') {

    if (!/^\d{7}$/.test(text))
      return ctx.reply('Invalid Meter ID');

    ctx.session.meter_id = text;

    if (ctx.session.disposition === 'Payment Issue') {
      ctx.session.step = 'fare';
      return ctx.reply('Enter Fare:');
    }

    if (ctx.session.disposition === 'Stuck Booking') {
      ctx.session.step = 'description';
      return ctx.reply('Enter Description:');
    }
  }

  if (ctx.session.step === 'fare') {
    ctx.session.fare = text;
    ctx.session.step = 'time';
    return ctx.reply('Enter Time:');
  }

  if (ctx.session.step === 'time') {
    ctx.session.time = text;
    ctx.session.step = 'photo_option';
    return ctx.reply('Do you want to attach a photo?', photoButtons());
  }

  if (ctx.session.step === 'description') {
    ctx.session.description = text;
    return createTicket(ctx);
  }

});

/* ================= PHOTO OPTIONS ================= */

bot.action('send_photo', ctx => {
  ctx.session.step = 'awaiting_photo';
  return ctx.reply('Send photo now');
});

bot.action('skip_photo', ctx => createTicket(ctx));

bot.on('photo', ctx => {

  const fileId = ctx.message.photo.pop().file_id;

  if (ctx.session.step === 'awaiting_photo') {
    ctx.session.photo = fileId;
    return createTicket(ctx);
  }

  if (ctx.session.step === 'awaiting_profile_picture') {
    ctx.session.photo = fileId;
    ctx.session.description = 'Profile Picture Update';
    return createTicket(ctx);
  }

});

/* ================= TICKET NUMBER ================= */

async function generateTicketNumber() {

  const { count } = await supabase
    .from('tickets')
    .select('*', { count: 'exact', head: true });

  return 'HALA-' + String((count || 0) + 1).padStart(3, '0');
}

/* ================= ADMIN QUEUE MESSAGE ================= */

async function sendToSupportQueue(ctx, ticket) {

  const adminChatId = process.env.ADMIN_CHAT_ID;

  if (!adminChatId) {
    console.log('ADMIN_CHAT_ID missing');
    return;
  }

  const message =
`✅ Ticket Created

Ticket: ${ticket.ticket_number}
Type: ${ctx.session.disposition}
Meter ID: ${ctx.session.meter_id || 'N/A'}
Fare: ${ctx.session.fare || 'N/A'}
Time: ${ctx.session.time || 'N/A'}
Description: ${ctx.session.description || 'N/A'}
Priority: Medium
Status: Pending`;

  await bot.telegram.sendMessage(adminChatId, message);

  if (ctx.session.photo)
    await bot.telegram.sendPhoto(adminChatId, ctx.session.photo);

}

/* ================= CREATE TICKET ================= */

async function createTicket(ctx) {

  try {

    const ticketNumber = await generateTicketNumber();

    const { data } = await supabase
      .from('tickets')
      .insert([{
        ticket_number: ticketNumber,
        driver_id: ctx.session.meter_id,
        disposition: ctx.session.disposition,
        description: ctx.session.description,
        fare: ctx.session.fare,
        time: ctx.session.time,
        status: 'Pending',
        priority: 'Medium'
      }])
      .select()
      .single();

    await sendToSupportQueue(ctx, data);

    ctx.session = {};

    return ctx.reply(`✅ Ticket Created\nTicket: ${ticketNumber}`);

  } catch (err) {

    console.log(err);
    return ctx.reply('Error creating ticket');

  }
}

/* ================= DASHBOARD ================= */

app.get('/dashboard', async (req, res) => {

  const { data } = await supabase
    .from('tickets')
    .select('*')
    .order('created_at', { ascending:false });

  const rows = data.map(t =>
`<tr>
<td>${t.ticket_number}</td>
<td>${t.disposition}</td>
<td>${t.driver_id}</td>
<td>${t.status}</td>
<td>${t.description}</td>
</tr>`
).join('');

  res.send(`
  <h2>Hala Support Dashboard</h2>
  <table border="1" cellpadding="6">
  <tr>
  <th>Ticket</th>
  <th>Type</th>
  <th>Meter</th>
  <th>Status</th>
  <th>Description</th>
  </tr>
  ${rows}
  </table>
  `);

});

/* ================= SERVER ================= */

app.get('/', (req,res)=>res.send('Running'));

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {

  await bot.telegram.setWebhook(RENDER_URL + WEBHOOK_PATH);

  console.log('Bot running');

});
