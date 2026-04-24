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

bot.use(session());

/* ================= MENU ================= */

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
    ]
  ]);
}

/* ================= START FIX ================= */

bot.start(async (ctx) => {
  ctx.session = {};
  return ctx.reply('Welcome to Hala Captain Support Bot', mainMenuButtons());
});

/* ================= MAIN MENU ================= */

bot.action('menu_create_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'disposition' };
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
  return ctx.editMessageText('Main Menu', mainMenuButtons());
});

/* ================= FIXED DISPOSITIONS ================= */

// PAYMENT ISSUE (FIXED FLOW)
bot.action('disp_payment', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    disposition: 'Payment Issue',
    step: 'meter_id'
  };
  return ctx.reply('Enter 7-digit Meter ID:');
});

// STUCK BOOKING (FIXED FLOW)
bot.action('disp_stuck_booking', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    disposition: 'Stuck Booking',
    step: 'meter_id'
  };
  return ctx.reply('Enter 7-digit Meter ID:');
});

// DEVICE ISSUE FIXED MESSAGE
bot.action('disp_device_issue', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.reply(
    '⚠️ Please visit Hala Home for Device Issue Support.\nThanks'
  );
});

// ACCOUNT BLOCK FIXED MESSAGE
bot.action('disp_account_block', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.reply(
    '👋 Dear Captain, Visit the Hala Home for the Account Block/Suspend. Thanks'
  );
});

/* ================= PROFILE UPDATE ================= */

bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'profile_update_type' };
  return ctx.editMessageText('Select Profile Update Type:', profileUpdateButtons());
});

// NUMBER UPDATE FIX
bot.action('profile_number_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    disposition: 'Profile Update',
    profile_update_type: 'Number Update',
    step: 'meter_id'
  };
  return ctx.reply('Enter 7-digit Meter ID:');
});

// PROFILE PICTURE
bot.action('profile_picture_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {
    disposition: 'Profile Update',
    profile_update_type: 'Profile Picture Update',
    step: 'meter_id'
  };
  return ctx.reply('Upload picture (White Background & Uniform)');
});

/* ================= TEXT FLOW FIX ================= */

bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const text = ctx.message.text;

  // ================= METER ID HANDLING =================
  if (ctx.session.step === 'meter_id') {

    ctx.session.meter_id = text;

    // PAYMENT ISSUE → continue flow
    if (ctx.session.disposition === 'Payment Issue') {
      ctx.session.step = 'fare';
      return ctx.reply('Enter Fare:');
    }

    // STUCK BOOKING → continue flow
    if (ctx.session.disposition === 'Stuck Booking') {
      ctx.session.step = 'car_side_number';
      return ctx.reply('Enter Car Side Number:');
    }

    // PROFILE UPDATE → NUMBER UPDATE FIXED (YOUR REQUEST)
    if (ctx.session.disposition === 'Profile Update') {

      if (ctx.session.profile_update_type === 'Number Update') {
        ctx.session.step = null;

        return ctx.reply(
          '📲 Please click the link to update your number:\n\nhttps://tinyurl.com/2p6spcpb'
        );
      }

      if (ctx.session.profile_update_type === 'Profile Picture Update') {
        ctx.session.step = 'awaiting_profile_picture';
        return ctx.reply('Upload Profile Picture Now');
      }
    }
  }

  // ================= PAYMENT FLOW =================
  if (ctx.session.step === 'fare') {
    ctx.session.fare = text;
    ctx.session.step = 'time';
    return ctx.reply('Enter Time:');
  }

  if (ctx.session.step === 'time') {
    ctx.session.time = text;
    ctx.session.step = 'awaiting_photo';
    return ctx.reply('Send Photo or Skip');
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
});

/* ================= CREATE TICKET (UNCHANGED) ================= */

async function createTicket(ctx) {
  try {
    const { data, error } = await supabase
      .from('tickets')
      .insert([{
        ticket_number: 'HALA-' + Math.floor(1000 + Math.random() * 9000),
        telegram_user_id: String(ctx.from.id),
        driver_id: ctx.session.meter_id,
        disposition: ctx.session.disposition,
        description: ctx.session.description,
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

app.get('/', (req, res) => res.send('Bot Running'));

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(RENDER_URL + WEBHOOK_PATH);
  console.log('Bot Running');
});
