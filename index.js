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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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

// ================= BOT SESSION =================

bot.use(session());

// ================= INLINE MENUS =================

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

function photoStepButtons() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Skip Photo', 'skip_photo'),
      Markup.button.callback('Cancel', 'nav_cancel')
    ]
  ]);
}

function ticketButtons(ticketId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Assign to Me', `assign_${ticketId}`),
      Markup.button.callback('Resolve', `resolve_${ticketId}`)
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

function getStatusBadge(status) {
  if (status === 'Resolved') {
    return '<span class="badge status-resolved">Resolved</span>';
  }
  if (status === 'Pending' || status === 'New') {
    return '<span class="badge status-pending">Pending</span>';
  }
  return `<span class="badge status-open">${status || 'Open'}</span>`;
}

function getPriorityBadge(priority) {
  if (priority === 'High') {
    return '<span class="badge priority-high">High</span>';
  }
  if (priority === 'Medium') {
    return '<span class="badge priority-medium">Medium</span>';
  }
  return `<span class="badge priority-low">${priority || 'Low'}</span>`;
}

function protectDashboard(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Hala Dashboard"');
    return res.status(401).send('Authentication required.');
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [username, password] = credentials.split(':');

  if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Hala Dashboard"');
  return res.status(401).send('Invalid credentials.');
}

async function sendMainMenu(ctx, text = 'Welcome to Hala Driver Support Bot') {
  ctx.session = {};
  return ctx.reply(text, mainMenuButtons());
}

function buildTicketMessage(ticket, assignedNameOverride = null, resolved = false) {
  const assignedText = assignedNameOverride || ticket.assigned_agent || 'Not Assigned';
  const statusText = resolved ? '🟢 Resolved' : '🟡 Pending';

  return (
    `${resolved ? '✅ Ticket Resolved' : '📝 Ticket Updated'}\n\n` +
    `Ticket: ${ticket.ticket_number || ticket.id}\n` +
    `Type: ${ticket.disposition || '-'}\n` +
    `Meter ID: ${ticket.driver_id || '-'}\n` +
    `${ticket.details_json && ticket.details_json.mobile_number ? `Mobile Number: ${ticket.details_json.mobile_number}\n` : ''}` +
    `Priority: ${ticket.priority || '-'}\n` +
    `Assigned: ${assignedText}\n` +
    `Status: ${statusText}`
  );
}

// ================= DUPLICATE-SAFE TICKET NUMBER =================

async function getNextTicketNumber() {
  const { data, error } = await supabase.rpc('generate_hala_ticket_number');

  if (error) {
    console.log('Ticket number RPC error:', JSON.stringify(error, null, 2));
    throw new Error('Failed to generate ticket number');
  }

  return data;
}

// ================= GOOGLE SHEETS HELPERS =================

async function appendTicketToGoogleSheet(ticket) {
  try {
    if (
      !process.env.GOOGLE_SHEET_ID ||
      !process.env.GOOGLE_CLIENT_EMAIL ||
      !process.env.GOOGLE_PRIVATE_KEY
    ) {
      console.log('Google Sheets env vars missing, skipping sheet append');
      return;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Hala Support Tickets!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          ticket.ticket_number || '',
          ticket.created_at || new Date().toISOString(),
          ticket.driver_id || '',
          ticket.disposition || '',
          ticket.description || '',
          ticket.priority || '',
          ticket.status || '',
          ticket.assigned_agent || 'Not Assigned',
          ticket.telegram_user_id || '',
          ticket.photo_file_id || '',
          ticket.id || '',
          ticket.resolved_at || ''
        ]]
      }
    });

    console.log('Ticket appended to Google Sheet');
  } catch (err) {
    console.log('Sheet error:', err.message);
    if (err.response && err.response.data) {
      console.log('Sheet error details:', err.response.data);
    }
  }
}

async function updateResolvedTicketInGoogleSheet(ticket) {
  try {
    if (
      !process.env.GOOGLE_SHEET_ID ||
      !process.env.GOOGLE_CLIENT_EMAIL ||
      !process.env.GOOGLE_PRIVATE_KEY
    ) {
      console.log('Google Sheets env vars missing, skipping sheet update');
      return;
    }

    const getResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Hala Support Tickets!A:L'
    });

    const rows = getResponse.data.values || [];
    if (rows.length < 2) {
      console.log('No data rows found in Google Sheet');
      return;
    }

    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const ticketNumberInSheet = row[0];

      if (ticketNumberInSheet === ticket.ticket_number) {
        targetRowIndex = i + 1;
        break;
      }
    }

    if (targetRowIndex === -1) {
      console.log(`Ticket ${ticket.ticket_number} not found in Google Sheet`);
      return;
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Hala Support Tickets!G${targetRowIndex}:L${targetRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          'Resolved',
          ticket.assigned_agent || 'Not Assigned',
          ticket.telegram_user_id || '',
          ticket.photo_file_id || '',
          ticket.id || '',
          ticket.resolved_at || new Date().toISOString()
        ]]
      }
    });

    console.log(`Google Sheet updated for resolved ticket ${ticket.ticket_number}`);
  } catch (err) {
    console.log('Google Sheet resolve update error:', err.message);
    if (err.response && err.response.data) {
      console.log('Google error response:', err.response.data);
    }
  }
}

async function sendUnresolvedAlert(ticket) {
  try {
    if (!process.env.TEAM_CHAT_ID) return;

    const assignedText = ticket.assigned_agent || 'Not Assigned';
    const minutesOpen = Math.floor(
      (Date.now() - new Date(ticket.created_at).getTime()) / 60000
    );

    await bot.telegram.sendMessage(
      process.env.TEAM_CHAT_ID,
      `🚨 Unresolved Ticket Alert\n\n` +
        `Ticket: ${ticket.ticket_number || ticket.id}\n` +
        `Type: ${ticket.disposition || '-'}\n` +
        `Meter ID: ${ticket.driver_id || '-'}\n` +
        `Priority: ${ticket.priority || '-'}\n` +
        `Assigned: ${assignedText}\n` +
        `Status: 🟡 Pending\n` +
        `Open For: ${minutesOpen} minutes\n` +
        `Reminder: Still not resolved`
    );
  } catch (err) {
    console.log('Unresolved alert send error:', err);
  }
}

async function checkUnresolvedTickets() {
  try {
    const now = new Date();

    const firstAlertThreshold = new Date(
      now.getTime() - ALERT_AFTER_MINUTES * 60 * 1000
    ).toISOString();

    const repeatAlertThreshold = new Date(
      now.getTime() - REPEAT_ALERT_MINUTES * 60 * 1000
    ).toISOString();

    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .neq('status', 'Resolved')
      .lte('created_at', firstAlertThreshold);

    if (error) {
      console.log('Unresolved ticket query error:', error);
      return;
    }

    for (const ticket of data || []) {
      const shouldSendFirstAlert = !ticket.last_alert_at;
      const shouldSendRepeatAlert =
        ticket.last_alert_at &&
        new Date(ticket.last_alert_at).toISOString() <= repeatAlertThreshold;

      if (!shouldSendFirstAlert && !shouldSendRepeatAlert) {
        continue;
      }

      await sendUnresolvedAlert(ticket);

      const { error: updateError } = await supabase
        .from('tickets')
        .update({
          alert_sent: true,
          last_alert_at: now.toISOString(),
          updated_at: now.toISOString()
        })
        .eq('id', ticket.id);

      if (updateError) {
        console.log('Failed updating last_alert_at:', updateError);
      }
    }
  } catch (err) {
    console.log('checkUnresolvedTickets error:', err);
  }
}

// ================= START + MENU =================

bot.start(async (ctx) => {
  return sendMainMenu(ctx, 'Welcome to Hala Driver Support Bot');
});

bot.command('menu', async (ctx) => {
  return sendMainMenu(ctx, 'Main menu');
});

bot.command('cancel', async (ctx) => {
  ctx.session = {};
  return ctx.reply('Cancelled.\n\nTo start again, send /start');
});

// ================= MENU ACTIONS =================

bot.action('menu_create_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'disposition' };

  return ctx.editMessageText('Select issue type:', issueTypeButtons());
});

bot.action('menu_check_status', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'check_ticket_number' };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Please enter ticket number:');
});

bot.action('nav_back_main', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};

  return ctx.editMessageText('Welcome to Hala Driver Support Bot', mainMenuButtons());
});

bot.action('nav_cancel', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  ctx.session = {};
  return ctx.reply('Cancelled.\n\nTo start again, send /start');
});

// ================= DISPOSITION ACTIONS =================

bot.action('disp_payment', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Payment Issue',
    step: 'meter_id'
  };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_account_block', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Account Block',
    step: 'meter_id'
  };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_stuck_booking', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Stuck Booking',
    step: 'meter_id'
  };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_device_issue', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Device Issue',
    step: 'meter_id'
  };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Profile Update',
    step: 'profile_update_type'
  };

  return ctx.editMessageText('Select profile update type:', profileUpdateButtons());
});

bot.action('profile_number_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    ...ctx.session,
    disposition: 'Profile Update',
    profile_update_type: 'Number Update',
    step: 'meter_id'
  };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('profile_picture_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    ...ctx.session,
    disposition: 'Profile Update',
    profile_update_type: 'Profile Picture Update',
    step: 'meter_id'
  };

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Enter 7-digit Meter ID:');
});

// ================= OPTIONAL PHOTO SKIP =================

bot.action('skip_photo', async (ctx) => {
  await ctx.answerCbQuery();

  if (!ctx.session || ctx.session.step !== 'awaiting_photo') {
    return;
  }

  ctx.session.photo_file_id = null;
  ctx.session.step = 'description';

  try {
    await ctx.deleteMessage();
  } catch (e) {}

  return ctx.reply('Photo skipped. Enter description:');
});

// ================= PHOTO =================

bot.on('photo', async (ctx) => {
  try {
    if (!ctx.session) return;

    const photo = ctx.message.photo[ctx.message.photo.length - 1];

    if (ctx.session.step === 'awaiting_photo') {
      ctx.session.photo_file_id = photo.file_id;
      ctx.session.step = 'description';
      return ctx.reply('Photo received. Enter description:');
    }

    if (ctx.session.step === 'awaiting_profile_picture') {
      ctx.session.photo_file_id = photo.file_id;
      ctx.session.description = 'Profile Update Request - Profile Picture Update';
      return createTicket(ctx);
    }
  } catch (err) {
    console.log('Photo error:', err);
    return ctx.reply('Error receiving photo');
  }
});

// ================= TEAM ACTION BUTTONS =================

bot.action(/assign_(.+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Assigning...');

    const ticketId = ctx.match[1];
    const agentName = ctx.from.username
      ? `@${ctx.from.username}`
      : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');

    const { data, error } = await supabase
      .from('tickets')
      .update({
        assigned_agent: agentName,
        updated_at: new Date().toISOString()
      })
      .eq('id', ticketId)
      .select()
      .maybeSingle();

    if (error || !data) {
      console.log('Assign button error:', error || 'No matching ticket found');
      return ctx.answerCbQuery('Failed to assign ticket');
    }

    const newText = buildTicketMessage(data, agentName, false);

    if (data.photo_file_id) {
      await ctx.editMessageCaption(newText, {
        reply_markup: ticketButtons(ticketId).reply_markup
      });
    } else {
      await ctx.editMessageText(newText, ticketButtons(ticketId));
    }
  } catch (err) {
    console.log('Assign action error:', err);
    try {
      await ctx.answerCbQuery('Something went wrong');
    } catch (e) {}
  }
});

bot.action(/resolve_(.+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery('Resolving...');

    const ticketId = ctx.match[1];

    const { data, error } = await supabase
      .from('tickets')
      .update({
        status: 'Resolved',
        resolved_at: new Date().toISOString(),
        alert_sent: false,
        last_alert_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', ticketId)
      .select()
      .maybeSingle();

    if (error || !data) {
      console.log('Resolve button error:', error || 'No matching ticket found');
      return ctx.answerCbQuery('Failed to resolve ticket');
    }

    await updateResolvedTicketInGoogleSheet(data);

    try {
      await bot.telegram.sendMessage(
        data.telegram_user_id,
        `✅ Ticket resolved: ${data.ticket_number || ticketId}`
      );
    } catch (notifyErr) {
      console.log('Driver notify error:', notifyErr);
    }

    const newText = buildTicketMessage(data, null, true);

    if (data.photo_file_id) {
      await ctx.editMessageCaption(newText);
    } else {
      await ctx.editMessageText(newText);
    }
  } catch (err) {
    console.log('Resolve action error:', err);
    try {
      await ctx.answerCbQuery('Something went wrong');
    } catch (e) {}
  }
});

// ================= TEXT FLOW =================

bot.on('text', async (ctx) => {
  try {
    if (!ctx.session) ctx.session = {};

    const text = sanitizeText(ctx.message.text);

    if (/^\/start$/i.test(text) || /^\/menu$/i.test(text) || /^\/cancel$/i.test(text)) {
      return;
    }

    if (!ctx.session.step) {
      return;
    }

    if (ctx.session.step === 'check_ticket_number') {
      const numericPart = text.replace(/\D/g, '');

      const { data, error } = await supabase
        .from('tickets')
        .select('*')
        .or(`ticket_number.eq.${text},id.eq.${numericPart || 0}`)
        .single();

      ctx.session = {};

      if (error || !data) {
        return ctx.reply('Ticket not found.\n\nTo try again, send /start');
      }

      return ctx.reply(
        `Ticket: ${data.ticket_number || data.id}\n` +
        `Type: ${data.disposition || '-'}\n` +
        `Status: ${data.status || '-'}\n` +
        `Priority: ${data.priority || '-'}\n` +
        `Assigned: ${data.assigned_agent || 'Not Assigned'}\n\n` +
        `To start again, send /start`
      );
    }

    if (ctx.session.step === 'meter_id') {
      if (!isValidMeterId(text)) {
        return ctx.reply('Enter valid 7 digit Meter ID');
      }

      ctx.session.meter_id = text;

      if (ctx.session.disposition === 'Payment Issue') {
        ctx.session.step = 'fare';
        return ctx.reply('Enter Fare:');
      }

      if (ctx.session.disposition === 'Account Block') {
        return createTicket(ctx);
      }

      if (ctx.session.disposition === 'Stuck Booking') {
        ctx.session.step = 'car_side_number';
        return ctx.reply('Enter Car Side Number:');
      }

      if (ctx.session.disposition === 'Device Issue') {
        ctx.session.step = 'device_id';
        return ctx.reply('Enter Device ID:');
      }

      if (ctx.session.disposition === 'Profile Update') {
        if (ctx.session.profile_update_type === 'Number Update') {
          ctx.session.step = 'mobile_number';
          return ctx.reply('Enter Mobile Number:');
        }

        if (ctx.session.profile_update_type === 'Profile Picture Update') {
          ctx.session.step = 'awaiting_profile_picture';
          return ctx.reply('Upload picture with White Background and in Uniform.');
        }
      }
    }

    if (ctx.session.step === 'fare') {
      ctx.session.fare = text;
      ctx.session.step = 'time';
      return ctx.reply('Enter Time:');
    }

    if (ctx.session.step === 'time') {
      ctx.session.time = text;
      ctx.session.step = 'awaiting_photo';
      return ctx.reply('Send photo, or tap Skip Photo.', photoStepButtons());
    }

    if (ctx.session.step === 'car_side_number') {
      ctx.session.car_side_number = text;
      return createTicket(ctx);
    }

    if (ctx.session.step === 'device_id') {
      ctx.session.device_id = text;
      ctx.session.step = 'description';
      return ctx.reply('Enter short description:');
    }

    if (ctx.session.step === 'mobile_number') {
      if (!isValidMobileNumber(text)) {
        return ctx.reply('Enter valid Mobile Number');
      }

      ctx.session.mobile_number = text;
      ctx.session.description = `Profile Update Request - Number Update\nMobile Number: ${text}`;
      return createTicket(ctx);
    }

    if (ctx.session.step === 'description') {
      ctx.session.description = text;
      return createTicket(ctx);
    }
  } catch (err) {
    console.log('Text error:', err);
    ctx.session = {};
    return ctx.reply('Something went wrong.\n\nTo start again, send /start');
  }
});

// ================= CREATE TICKET =================

async function createTicket(ctx) {
  try {
    let priority = 'Medium';

    if (
      ctx.session.disposition === 'Account Block' ||
      ctx.session.disposition === 'Stuck Booking'
    ) {
      priority = 'High';
    }

    let data = null;
    let error = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const ticketNumber = await getNextTicketNumber();

      const details = {
        meter_id: ctx.session.meter_id,
        fare: ctx.session.fare || null,
        time: ctx.session.time || null,
        car_side_number: ctx.session.car_side_number || null,
        device_id: ctx.session.device_id || null,
        profile_update_type: ctx.session.profile_update_type || null,
        mobile_number: ctx.session.mobile_number || null
      };

      const finalDisposition =
        ctx.session.disposition === 'Profile Update' && ctx.session.profile_update_type
          ? `Profile Update - ${ctx.session.profile_update_type}`
          : ctx.session.disposition;

      const result = await supabase
        .from('tickets')
        .insert([
          {
            ticket_number: ticketNumber,
            telegram_user_id: String(ctx.from.id),
            driver_id: ctx.session.meter_id,
            disposition: finalDisposition,
            description: ctx.session.description || null,
            details_json: details,
            photo_file_id: ctx.session.photo_file_id || null,
            priority,
            status: 'Pending',
            assigned_agent: null,
            alert_sent: false,
            last_alert_at: null,
            updated_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      data = result.data;
      error = result.error;

      if (!error) {
        break;
      }

      const isUniqueViolation =
        error.code === '23505' ||
        String(error.message || '').toLowerCase().includes('duplicate');

      if (!isUniqueViolation) {
        break;
      }
    }

    if (error) {
      console.log('Database error FULL:', JSON.stringify(error, null, 2));
      ctx.session = {};
      return ctx.reply(`Database error: ${error.message}`);
    }

    await appendTicketToGoogleSheet(data);

    try {
      if (process.env.TEAM_CHAT_ID) {
        const ticketMessage =
          `🆕 New Ticket Created\n\n` +
          `Ticket: ${data.ticket_number}\n` +
          `Type: ${data.disposition}\n` +
          `Meter ID: ${ctx.session.meter_id}\n` +
          `${ctx.session.mobile_number ? `Mobile Number: ${ctx.session.mobile_number}\n` : ''}` +
          `Priority: ${priority}\n` +
          `Assigned: Not Assigned\n` +
          `Status: 🟡 Pending`;

        if (ctx.session.photo_file_id) {
          await bot.telegram.sendPhoto(
            process.env.TEAM_CHAT_ID,
            ctx.session.photo_file_id,
            {
              caption: ticketMessage,
              reply_markup: ticketButtons(data.id).reply_markup
            }
          );
        } else {
          await bot.telegram.sendMessage(
            process.env.TEAM_CHAT_ID,
            ticketMessage,
            ticketButtons(data.id)
          );
        }
      }
    } catch (notifyErr) {
      console.log('Notification error:', notifyErr);
    }

    ctx.session = {};
    return ctx.reply(
      `✅ Ticket created successfully\nTicket Number: ${data.ticket_number}\n\nTo create a new ticket, send /start`
    );
  } catch (err) {
    console.log('Create ticket error:', err);
    ctx.session = {};
    return ctx.reply(`Error saving ticket: ${err.message}`);
  }
}

// ================= SERVER ROUTES =================

app.get('/', (req, res) => {
  res.send('Bot server is running');
});

app.get('/dashboard', protectDashboard, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .order('id', { ascending: false });

    if (error) {
      console.log('Dashboard error:', error);
      return res.send('Error loading dashboard');
    }

    const tickets = data || [];

    const total = tickets.length;
    const open = tickets.filter(t => t.status !== 'Resolved').length;
    const resolved = tickets.filter(t => t.status === 'Resolved').length;
    const high = tickets.filter(t => t.priority === 'High').length;

    const uniqueAgents = [...new Set(
      tickets
        .map(t => t.assigned_agent || 'Not Assigned')
        .filter(v => v && v.trim() !== '')
    )].sort();

    const byStatus = {};
    const byPriority = {};
    const byDay = {};
    const byAgent = {};
    const byType = {};

    tickets.forEach(t => {
      const status = t.status || 'Pending';
      const priority = t.priority || 'Low';
      const agent = t.assigned_agent || 'Not Assigned';
      const type = t.disposition || 'Unknown';

      byStatus[status] = (byStatus[status] || 0) + 1;
      byPriority[priority] = (byPriority[priority] || 0) + 1;
      byAgent[agent] = (byAgent[agent] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;

      const createdAt = t.created_at
        ? new Date(t.created_at).toISOString().slice(0, 10)
        : 'Unknown';

      byDay[createdAt] = (byDay[createdAt] || 0) + 1;
    });

    const dayLabels = Object.keys(byDay).sort();
    const dayValues = dayLabels.map(k => byDay[k]);

    const agentLabels = Object.keys(byAgent);
    const agentValues = agentLabels.map(k => byAgent[k]);

    const statusLabels = Object.keys(byStatus);
    const statusValues = statusLabels.map(k => byStatus[k]);

    const maxDayValue = Math.max(...dayValues, 1);
    const maxAgentValue = Math.max(...agentValues, 1);
    const maxStatusValue = Math.max(...statusValues, 1);
    const maxTypeValue = Math.max(...Object.values(byType), 1);

    let rows = '';

    tickets.forEach(t => {
      const status = t.status || 'Pending';
      const priority = t.priority || 'Low';
      const agent = t.assigned_agent || 'Not Assigned';
      const type = t.disposition || 'Unknown';

      rows += `
        <tr
          data-status="${status}"
          data-priority="${priority}"
          data-agent="${agent}"
          data-type="${type}"
          data-created="${t.created_at || ''}"
        >
          <td>${t.ticket_number || '#' + t.id}</td>
          <td>${t.disposition || '-'}</td>
          <td>${getStatusBadge(status)}</td>
          <td>${agent}</td>
          <td>${t.driver_id || '-'}</td>
          <td>${getPriorityBadge(priority)}</td>
          <td>${t.created_at ? new Date(t.created_at).toLocaleString() : '-'}</td>
        </tr>
      `;
    });

    const dayBars = dayLabels.map((label, i) => `
      <div class="bar-row">
        <div class="bar-label">${label}</div>
        <div class="bar-track">
          <div class="bar-fill blue" style="width:${(dayValues[i] / maxDayValue) * 100}%"></div>
        </div>
        <div class="bar-value">${dayValues[i]}</div>
      </div>
    `).join('');

    const agentBars = agentLabels.map((label, i) => `
      <div class="bar-row">
        <div class="bar-label">${label}</div>
        <div class="bar-track">
          <div class="bar-fill green" style="width:${(agentValues[i] / maxAgentValue) * 100}%"></div>
        </div>
        <div class="bar-value">${agentValues[i]}</div>
      </div>
    `).join('');

    const statusBars = statusLabels.map((label, i) => `
      <div class="bar-row">
        <div class="bar-label">${label}</div>
        <div class="bar-track">
          <div class="bar-fill orange" style="width:${(statusValues[i] / maxStatusValue) * 100}%"></div>
        </div>
        <div class="bar-value">${statusValues[i]}</div>
      </div>
    `).join('');

    const sortedTypeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);

    const typeBars = sortedTypeEntries.map(([label, value]) => `
      <div class="bar-row">
        <div class="bar-label">${label}</div>
        <div class="bar-track">
          <div class="bar-fill purple" style="width:${(value / maxTypeValue) * 100}%"></div>
        </div>
        <div class="bar-value">${value}</div>
      </div>
    `).join('');

    const agentOptions = uniqueAgents.map(agent => `
      <option value="${agent}">${agent}</option>
    `).join('');

    const dashboardTickets = tickets.map(t => ({
      ticket_number: t.ticket_number || `#${t.id}`,
      disposition: t.disposition || 'Unknown',
      status: t.status || 'Pending',
      assigned_agent: t.assigned_agent || 'Not Assigned',
      driver_id: t.driver_id || '-',
      priority: t.priority || 'Low',
      created_at: t.created_at || ''
    }));

    const ticketsJson = JSON.stringify(dashboardTickets).replace(/</g, '\\u003c');

    const html = `
    <html>
    <head>
      <title>Hala Analytics Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Arial, sans-serif;
          background: #f3f7ff;
          color: #1f2937;
        }
        .topbar {
          background: linear-gradient(135deg, #3886fc, #2563eb);
          color: white;
          padding: 24px 32px;
          box-shadow: 0 4px 16px rgba(37, 99, 235, 0.25);
        }
        .topbar h1 {
          margin: 0;
          font-size: 28px;
          font-weight: 700;
        }
        .topbar p {
          margin: 8px 0 0;
          font-size: 14px;
          opacity: 0.95;
        }
        .container {
          padding: 24px;
        }
        .cards {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 18px;
          margin-bottom: 24px;
        }
        .card {
          background: white;
          border-radius: 18px;
          padding: 22px;
          box-shadow: 0 8px 24px rgba(56, 134, 252, 0.12);
          border: 1px solid #e5edff;
        }
        .card-title {
          font-size: 14px;
          color: #6b7280;
          margin-bottom: 10px;
          font-weight: 600;
        }
        .card-value {
          font-size: 34px;
          font-weight: 700;
          color: #3886fc;
        }
        .filters, .charts-grid, .table-panel {
          background: white;
          border-radius: 18px;
          padding: 20px;
          box-shadow: 0 8px 24px rgba(56, 134, 252, 0.10);
          border: 1px solid #e5edff;
          margin-bottom: 24px;
        }
        .filters h2, .table-title, .chart-title {
          margin-top: 0;
          margin-bottom: 16px;
          font-size: 20px;
          color: #111827;
        }
        .filter-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px;
        }
        .filter-control {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .filter-control label {
          font-size: 13px;
          font-weight: 700;
          color: #4b5563;
        }
        .filter-control input,
        .filter-control select,
        .filter-control button {
          padding: 12px 14px;
          border: 1px solid #c7d7ff;
          border-radius: 12px;
          outline: none;
          font-size: 14px;
          background: white;
        }
        .filter-control input:focus,
        .filter-control select:focus {
          border-color: #3886fc;
          box-shadow: 0 0 0 3px rgba(56, 134, 252, 0.12);
        }
        .export-btn {
          background: linear-gradient(135deg, #10b981, #059669);
          color: white;
          border: none;
          cursor: pointer;
          font-weight: 700;
          margin-top: auto;
        }
        .export-btn:hover {
          opacity: 0.95;
        }
        .charts-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 18px;
          background: transparent;
          border: none;
          box-shadow: none;
          padding: 0;
        }
        .chart-card {
          background: white;
          border-radius: 18px;
          padding: 20px;
          box-shadow: 0 8px 24px rgba(56, 134, 252, 0.10);
          border: 1px solid #e5edff;
        }
        .bar-row {
          display: grid;
          grid-template-columns: 140px 1fr 40px;
          gap: 10px;
          align-items: center;
          margin-bottom: 12px;
        }
        .bar-label {
          font-size: 12px;
          color: #374151;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .bar-track {
          height: 14px;
          background: #eef2ff;
          border-radius: 999px;
          overflow: hidden;
        }
        .bar-fill {
          height: 100%;
          border-radius: 999px;
        }
        .bar-fill.blue {
          background: linear-gradient(90deg, #3886fc, #60a5fa);
        }
        .bar-fill.green {
          background: linear-gradient(90deg, #10b981, #34d399);
        }
        .bar-fill.orange {
          background: linear-gradient(90deg, #f59e0b, #fbbf24);
        }
        .bar-fill.purple {
          background: linear-gradient(90deg, #7c3aed, #a78bfa);
        }
        .bar-value {
          font-size: 12px;
          font-weight: 700;
          color: #111827;
          text-align: right;
        }
        .table-wrap {
          overflow-x: auto;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 900px;
        }
        th {
          text-align: left;
          padding: 14px 16px;
          background: #3886fc;
          color: white;
          font-size: 14px;
        }
        td {
          padding: 14px 16px;
          border-bottom: 1px solid #eef2ff;
          font-size: 14px;
          color: #374151;
        }
        tr:hover td {
          background: #f8fbff;
        }
        .badge {
          display: inline-block;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
        }
        .status-pending {
          background: #fef3c7;
          color: #b45309;
        }
        .status-open {
          background: #e0f2fe;
          color: #0369a1;
        }
        .status-resolved {
          background: #dcfce7;
          color: #15803d;
        }
        .priority-high {
          background: #fee2e2;
          color: #b91c1c;
        }
        .priority-medium {
          background: #fef3c7;
          color: #b45309;
        }
        .priority-low {
          background: #e0e7ff;
          color: #4338ca;
        }
        .empty-note {
          color: #6b7280;
          font-size: 14px;
        }
        .chart-subtitle {
          font-size: 12px;
          color: #6b7280;
          margin-top: -8px;
          margin-bottom: 16px;
        }
        @media (max-width: 768px) {
          .topbar { padding: 20px; }
          .container { padding: 16px; }
        }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Hala Analytics Dashboard</h1>
        <p>Filters, live ticket analytics, and support performance overview</p>
      </div>

      <div class="container">
        <div class="cards">
          <div class="card">
            <div class="card-title">Total Tickets</div>
            <div class="card-value">${total}</div>
          </div>
          <div class="card">
            <div class="card-title">Open Tickets</div>
            <div class="card-value">${open}</div>
          </div>
          <div class="card">
            <div class="card-title">Resolved Tickets</div>
            <div class="card-value">${resolved}</div>
          </div>
          <div class="card">
            <div class="card-title">High Priority</div>
            <div class="card-value">${high}</div>
          </div>
        </div>

        <div class="filters">
          <h2>Filters</h2>
          <div class="filter-grid">
            <div class="filter-control">
              <label>Search</label>
              <input type="text" id="searchInput" placeholder="Ticket, type, agent, meter..." onkeyup="filterTable()" />
            </div>
            <div class="filter-control">
              <label>Status</label>
              <select id="statusFilter" onchange="filterTable()">
                <option value="">All</option>
                <option value="Pending">Pending</option>
                <option value="Resolved">Resolved</option>
              </select>
            </div>
            <div class="filter-control">
              <label>Priority</label>
              <select id="priorityFilter" onchange="filterTable()">
                <option value="">All</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>
            <div class="filter-control">
              <label>Agent</label>
              <select id="agentFilter" onchange="filterTable()">
                <option value="">All</option>
                <option value="Not Assigned">Not Assigned</option>
                ${agentOptions}
              </select>
            </div>
            <div class="filter-control">
              <label>Type Count View</label>
              <select id="typeCountFilter" onchange="filterTable()">
                <option value="overall">Overall</option>
                <option value="today">Today</option>
                <option value="this_week">This Week</option>
              </select>
            </div>
            <div class="filter-control">
              <label>From Date</label>
              <input type="date" id="fromDate" onchange="filterTable()" />
            </div>
            <div class="filter-control">
              <label>To Date</label>
              <input type="date" id="toDate" onchange="filterTable()" />
            </div>
            <div class="filter-control">
              <label>Export Report</label>
              <button class="export-btn" onclick="exportReport()">Export CSV</button>
            </div>
          </div>
        </div>

        <div class="charts-grid">
          <div class="chart-card">
            <div class="chart-title">Tickets Per Day</div>
            ${dayBars || '<div class="empty-note">No data yet</div>'}
          </div>

          <div class="chart-card">
            <div class="chart-title">Agent Performance</div>
            ${agentBars || '<div class="empty-note">No assigned tickets yet</div>'}
          </div>

          <div class="chart-card">
            <div class="chart-title">Status Breakdown</div>
            ${statusBars || '<div class="empty-note">No status data yet</div>'}
          </div>

          <div class="chart-card">
            <div class="chart-title">Type Score Board</div>
            <div class="chart-subtitle">Use all filters, type view, and date range for reporting</div>
            <div id="typeScoreBoard">
              ${typeBars || '<div class="empty-note">No type data yet</div>'}
            </div>
          </div>
        </div>

        <div class="table-panel">
          <div class="table-title">Ticket List</div>
          <div class="table-wrap">
            <table id="ticketTable">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Agent</th>
                  <th>Meter</th>
                  <th>Priority</th>
                  <th>Created At</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <script>
        const allTickets = ${ticketsJson};

        function escapeHtml(value) {
          return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function startOfDay(date) {
          const d = new Date(date);
          d.setHours(0, 0, 0, 0);
          return d;
        }

        function endOfDay(date) {
          const d = new Date(date);
          d.setHours(23, 59, 59, 999);
          return d;
        }

        function isToday(dateString) {
          if (!dateString) return false;
          const today = startOfDay(new Date());
          const target = startOfDay(new Date(dateString));
          return target.getTime() === today.getTime();
        }

        function getWeekStart(date) {
          const d = new Date(date);
          d.setHours(0, 0, 0, 0);
          const day = d.getDay();
          const diff = day === 0 ? -6 : 1 - day;
          d.setDate(d.getDate() + diff);
          return d;
        }

        function isThisWeek(dateString) {
          if (!dateString) return false;
          const currentWeekStart = getWeekStart(new Date());
          const nextWeekStart = new Date(currentWeekStart);
          nextWeekStart.setDate(currentWeekStart.getDate() + 7);

          const target = new Date(dateString);
          return target >= currentWeekStart && target < nextWeekStart;
        }

        function inSelectedDateRange(dateString, fromDate, toDate) {
          if (!dateString) return false;

          const target = new Date(dateString);

          if (fromDate) {
            const from = startOfDay(new Date(fromDate));
            if (target < from) return false;
          }

          if (toDate) {
            const to = endOfDay(new Date(toDate));
            if (target > to) return false;
          }

          return true;
        }

        function getCurrentFilters() {
          return {
            search: document.getElementById('searchInput').value.toLowerCase().trim(),
            status: document.getElementById('statusFilter').value,
            priority: document.getElementById('priorityFilter').value,
            agent: document.getElementById('agentFilter').value,
            typeCountView: document.getElementById('typeCountFilter').value,
            fromDate: document.getElementById('fromDate').value,
            toDate: document.getElementById('toDate').value
          };
        }

        function matchesMainFilters(ticket, filters) {
          const searchableText = [
            ticket.ticket_number,
            ticket.disposition,
            ticket.status,
            ticket.assigned_agent,
            ticket.driver_id,
            ticket.priority
          ].join(' ').toLowerCase();

          const matchesSearch = !filters.search || searchableText.includes(filters.search);
          const matchesStatus = !filters.status || ticket.status === filters.status;
          const matchesPriority = !filters.priority || ticket.priority === filters.priority;
          const matchesAgent = !filters.agent || ticket.assigned_agent === filters.agent;
          const matchesDateRange = inSelectedDateRange(ticket.created_at, filters.fromDate, filters.toDate);

          return matchesSearch && matchesStatus && matchesPriority && matchesAgent && matchesDateRange;
        }

        function matchesTypePeriod(ticket, period) {
          if (period === 'today') {
            return isToday(ticket.created_at);
          }

          if (period === 'this_week') {
            return isThisWeek(ticket.created_at);
          }

          return true;
        }

        function getFilteredTicketsForScoreboard() {
          const filters = getCurrentFilters();

          return allTickets.filter(ticket =>
            matchesMainFilters(ticket, filters) && matchesTypePeriod(ticket, filters.typeCountView)
          );
        }

        function renderTypeScoreBoard() {
          const filteredTickets = getFilteredTicketsForScoreboard();
          const byType = {};

          filteredTickets.forEach(ticket => {
            const type = ticket.disposition || 'Unknown';
            byType[type] = (byType[type] || 0) + 1;
          });

          const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
          const container = document.getElementById('typeScoreBoard');

          if (!entries.length) {
            container.innerHTML = '<div class="empty-note">No type data for selected filters</div>';
            return;
          }

          const maxValue = Math.max(...entries.map(item => item[1]), 1);

          container.innerHTML = entries.map(([label, value]) => \`
            <div class="bar-row">
              <div class="bar-label">\${escapeHtml(label)}</div>
              <div class="bar-track">
                <div class="bar-fill purple" style="width:\${(value / maxValue) * 100}%"></div>
              </div>
              <div class="bar-value">\${value}</div>
            </div>
          \`).join('');
        }

        function filterTable() {
          const filters = getCurrentFilters();
          const rows = document.querySelectorAll('#ticketTable tbody tr');

          rows.forEach(row => {
            const text = row.innerText.toLowerCase();
            const rowStatus = row.getAttribute('data-status');
            const rowPriority = row.getAttribute('data-priority');
            const rowAgent = row.getAttribute('data-agent');
            const rowCreated = row.getAttribute('data-created');

            const matchesSearch = !filters.search || text.includes(filters.search);
            const matchesStatus = !filters.status || rowStatus === filters.status;
            const matchesPriority = !filters.priority || rowPriority === filters.priority;
            const matchesAgent = !filters.agent || rowAgent === filters.agent;
            const matchesDateRange = inSelectedDateRange(rowCreated, filters.fromDate, filters.toDate);

            row.style.display =
              matchesSearch && matchesStatus && matchesPriority && matchesAgent && matchesDateRange
                ? ''
                : 'none';
          });

          renderTypeScoreBoard();
        }

        function csvEscape(value) {
          const stringValue = String(value ?? '');
          if (stringValue.includes('"') || stringValue.includes(',') || stringValue.includes('\\n')) {
            return '"' + stringValue.replace(/"/g, '""') + '"';
          }
          return stringValue;
        }

        function exportReport() {
          const filters = getCurrentFilters();

          const filteredTickets = allTickets.filter(ticket => matchesMainFilters(ticket, filters));

          if (!filteredTickets.length) {
            alert('No data found for selected filters.');
            return;
          }

          const rows = [
            [
              'Ticket',
              'Type',
              'Status',
              'Agent',
              'Meter',
              'Priority',
              'Created At'
            ]
          ];

          filteredTickets.forEach(ticket => {
            rows.push([
              ticket.ticket_number,
              ticket.disposition,
              ticket.status,
              ticket.assigned_agent,
              ticket.driver_id,
              ticket.priority,
              ticket.created_at ? new Date(ticket.created_at).toLocaleString() : ''
            ]);
          });

          const csvContent = rows
            .map(row => row.map(csvEscape).join(','))
            .join('\\n');

          const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');

          const today = new Date();
          const fileDate = today.toISOString().slice(0, 10);

          link.href = url;
          link.setAttribute('download', \`hala-ticket-report-\${fileDate}.csv\`);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        }

        renderTypeScoreBoard();
      </script>
    </body>
    </html>
    `;

    res.send(html);
  } catch (err) {
    console.log(err);
    res.send('Error loading dashboard');
  }
});

// ================= WEBHOOK + SERVER =================

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
    console.log(`Webhook set to ${RENDER_URL}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error('Webhook setup error:', err.message);
  }
});

setInterval(checkUnresolvedTickets, 60 * 1000);

process.once('SIGINT', () => {
  console.log('SIGINT received');
});

process.once('SIGTERM', () => {
  console.log('SIGTERM received');
});
