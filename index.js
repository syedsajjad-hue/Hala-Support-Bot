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
    ],
    [
      Markup.button.callback('Back', 'nav_back_main')
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

function photoOptionButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📸 Send Photo', 'send_photo')],
    [Markup.button.callback('⏭ Skip Photo', 'skip_photo')]
  ]);
}

/* ================= START ================= */

bot.start(async (ctx) => {
  ctx.session = {};
  return ctx.reply('Welcome to Hala Captain Support', mainMenuButtons());
});

/* ================= MENU ================= */

bot.action('menu_create_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.editMessageText('Select issue type:', issueTypeButtons());
});

bot.action('menu_check_status', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'check_ticket' };
  return ctx.reply('Enter Ticket Number:');
});

bot.action('nav_back_main', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.editMessageText('Welcome to Hala Captain Support', mainMenuButtons());
});

/* ================= ISSUE TYPES ================= */

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

/* ================= PROFILE UPDATE ================= */

bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Profile Update',
    step: 'profile_update_type'
  };

  return ctx.editMessageText('Select Profile Update Type:', profileUpdateButtons());
});

bot.action('profile_number_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};

  return ctx.reply(
    'Please click on the link. Thanks\n\nhttps://tinyurl.com/2p6spcpb'
  );
});

bot.action('profile_picture_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Profile Update',
    profile_update_type: 'Profile Picture Update',
    step: 'awaiting_profile_picture'
  };

  return ctx.reply('Upload Profile Picture (White Background & Uniform)');
});

/* ================= TEXT FLOW ================= */

bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};

  const text = ctx.message.text.trim();

  if (ctx.session.step === 'check_ticket') {
    return checkTicketStatus(ctx, text);
  }

  if (ctx.session.step === 'meter_id') {
    if (!/^\d{7}$/.test(text)) {
      return ctx.reply('Invalid Meter ID. Enter 7 digits only.');
    }

    ctx.session.meter_id = text;

    if (ctx.session.disposition === 'Payment Issue') {
      ctx.session.step = 'fare';
      return ctx.reply('Enter Fare:');
    }

    if (ctx.session.disposition === 'Stuck Booking') {
      ctx.session.step = 'car_side_number';
      return ctx.reply('Enter Car Side Number:');
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

    return ctx.reply('Do you want to attach a photo?', photoOptionButtons());
  }

  if (ctx.session.step === 'car_side_number') {
    ctx.session.car_side_number = text;
    ctx.session.step = 'description';

    return ctx.reply('Enter Description:');
  }

  if (ctx.session.step === 'description') {
    ctx.session.description = text;
    return createTicket(ctx);
  }

  return ctx.reply('Please use /start to begin.');
});

/* ================= PHOTO OPTIONS ================= */

bot.action('send_photo', async (ctx) => {
  await ctx.answerCbQuery();

  if (!ctx.session || ctx.session.step !== 'photo_option') {
    return ctx.reply('Please start again using /start');
  }

  ctx.session.step = 'awaiting_photo';
  return ctx.reply('Please send the photo now 📸');
});

bot.action('skip_photo', async (ctx) => {
  await ctx.answerCbQuery();

  if (!ctx.session || ctx.session.step !== 'photo_option') {
    return ctx.reply('Please start again using /start');
  }

  ctx.session.photo = null;
  return createTicket(ctx);
});

/* ================= PHOTO HANDLER ================= */

bot.on('photo', async (ctx) => {
  if (!ctx.session) ctx.session = {};

  const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  if (ctx.session.step === 'awaiting_photo') {
    ctx.session.photo = photoId;
    return createTicket(ctx);
  }

  if (ctx.session.step === 'awaiting_profile_picture') {
    ctx.session.photo = photoId;
    ctx.session.description = 'Profile Picture Update';
    return createTicket(ctx);
  }

  return ctx.reply('Please select the correct option first.');
});

/* ================= TICKET NUMBER ================= */

async function generateTicketNumber() {
  const { count, error } = await supabase
    .from('tickets')
    .select('*', { count: 'exact', head: true });

  if (error) throw error;

  const nextNumber = (count || 0) + 1;
  return 'HALA-' + String(nextNumber).padStart(3, '0');
}

/* ================= ADMIN NOTIFICATION ================= */

async function sendAdminNotification(ctx, data) {
  try {
    if (!process.env.ADMIN_CHAT_ID) {
      console.log('ADMIN_CHAT_ID missing');
      return;
    }

    const adminMessage =
      `✅ New Ticket Created\n\n` +
      `Ticket: ${data.ticket_number}\n` +
      `Type: ${ctx.session.disposition || 'N/A'}\n` +
      `Meter ID: ${ctx.session.meter_id || 'N/A'}\n` +
      `Fare: ${ctx.session.fare || 'N/A'}\n` +
      `Time: ${ctx.session.time || 'N/A'}\n` +
      `Car Side Number: ${ctx.session.car_side_number || 'N/A'}\n` +
      `Description: ${ctx.session.description || 'N/A'}\n` +
      `Priority: Medium\n` +
      `Status: Pending`;

    await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, adminMessage);

    if (ctx.session.photo) {
      await bot.telegram.sendPhoto(process.env.ADMIN_CHAT_ID, ctx.session.photo, {
        caption: `Photo attached for Ticket: ${data.ticket_number}`
      });
    }

  } catch (err) {
    console.log('ADMIN NOTIFICATION ERROR:', err.message);
  }
}

/* ================= CREATE TICKET ================= */

async function createTicket(ctx) {
  try {
    const ticketNumber = await generateTicketNumber();

    const fullPayload = {
      ticket_number: ticketNumber,
      telegram_user_id: String(ctx.from.id),
      driver_id: ctx.session.meter_id || 'N/A',
      disposition: ctx.session.disposition || 'Unknown',
      description: ctx.session.description || 'N/A',
      fare: ctx.session.fare || '',
      time: ctx.session.time || '',
      photo: ctx.session.photo || null,
      car_side_number: ctx.session.car_side_number || '',
      status: 'Pending',
      priority: 'Medium'
    };

    let { data, error } = await supabase
      .from('tickets')
      .insert([fullPayload])
      .select()
      .single();

    if (error) {
      console.log('FULL INSERT FAILED:', error.message);

      const basicPayload = {
        ticket_number: ticketNumber,
        telegram_user_id: String(ctx.from.id),
        driver_id: ctx.session.meter_id || 'N/A',
        disposition: ctx.session.disposition || 'Unknown',
        description:
          `Issue: ${ctx.session.disposition || 'Unknown'}\n` +
          `Fare: ${ctx.session.fare || 'N/A'}\n` +
          `Time: ${ctx.session.time || 'N/A'}\n` +
          `Photo: ${ctx.session.photo || 'No Photo'}\n` +
          `Car Side Number: ${ctx.session.car_side_number || 'N/A'}\n` +
          `Description: ${ctx.session.description || 'N/A'}`,
        status: 'Pending',
        priority: 'Medium'
      };

      const retry = await supabase
        .from('tickets')
        .insert([basicPayload])
        .select()
        .single();

      data = retry.data;
      error = retry.error;
    }

    if (error) {
      console.log('SUPABASE ERROR:', error);
      return ctx.reply('Error creating ticket: ' + error.message);
    }

    await sendAdminNotification(ctx, data);

    ctx.session = {};

    return ctx.reply(`✅ Ticket Created\nTicket: ${data.ticket_number}`);

  } catch (err) {
    console.log('SERVER ERROR:', err);
    return ctx.reply('Error creating ticket: ' + err.message);
  }
}

/* ================= CHECK STATUS ================= */

async function checkTicketStatus(ctx, ticketNumber) {
  try {
    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .eq('ticket_number', ticketNumber)
      .single();

    if (error || !data) {
      return ctx.reply('Ticket not found.');
    }

    ctx.session = {};

    return ctx.reply(
      `Ticket: ${data.ticket_number}\nStatus: ${data.status || 'Pending'}`
    );

  } catch (err) {
    console.log('CHECK STATUS ERROR:', err.message);
    return ctx.reply('Error checking ticket.');
  }
}

/* ================= DASHBOARD ================= */

app.get('/dashboard', async (req, res) => {
  try {
    const { data: tickets, error } = await supabase
      .from('tickets')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const rows = (tickets || []).map(t => `
      <tr>
        <td>${t.ticket_number || ''}</td>
        <td>${t.disposition || ''}</td>
        <td>${t.driver_id || ''}</td>
        <td>${t.fare || ''}</td>
        <td>${t.time || ''}</td>
        <td>${t.car_side_number || ''}</td>
        <td>${t.priority || 'Medium'}</td>
        <td>${t.status || 'Pending'}</td>
        <td>${(t.description || '').replace(/\n/g, '<br>')}</td>
        <td>
          ${t.status === 'Resolved'
            ? 'Resolved'
            : `<a href="/resolve/${t.id}">Resolve</a>`
          }
        </td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Hala Support Dashboard</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 20px;
            background: #f5f5f5;
          }
          h1 {
            color: #222;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            font-size: 14px;
          }
          th, td {
            padding: 10px;
            border: 1px solid #ddd;
            text-align: left;
            vertical-align: top;
          }
          th {
            background: #00a859;
            color: white;
          }
          a {
            color: #00a859;
            font-weight: bold;
            text-decoration: none;
          }
          .top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
          }
          .btn {
            background: #00a859;
            color: white;
            padding: 8px 12px;
            border-radius: 6px;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="top">
          <h1>Hala Support Dashboard</h1>
          <a class="btn" href="/dashboard">Refresh</a>
        </div>

        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Type</th>
              <th>Meter ID</th>
              <th>Fare</th>
              <th>Time</th>
              <th>Car Side</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Description</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="10">No tickets found</td></tr>'}
          </tbody>
        </table>
      </body>
      </html>
    `);

  } catch (err) {
    console.log('DASHBOARD ERROR:', err.message);
    res.send('Dashboard error: ' + err.message);
  }
});

/* ================= RESOLVE TICKET ================= */

app.get('/resolve/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('tickets')
      .update({ status: 'Resolved' })
      .eq('id', id);

    if (error) throw error;

    res.redirect('/dashboard');

  } catch (err) {
    console.log('RESOLVE ERROR:', err.message);
    res.send('Resolve error: ' + err.message);
  }
});

/* ================= SERVER ================= */

app.get('/', (req, res) => res.send('Running'));

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(RENDER_URL + WEBHOOK_PATH);
  console.log('Bot running');
});
