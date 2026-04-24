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

// ================= SESSION =================
bot.use(session({ defaultSession: () => ({}) }));

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

// ================= START FIX =================
bot.start(async (ctx) => {
  ctx.session = {};
  return ctx.reply(
    '👋 Welcome to Hala Captain Support Bot',
    mainMenuButtons()
  );
});

// ================= MAIN MENU =================
bot.action('menu_create_ticket', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'disposition' };
  return ctx.editMessageText('Select issue type:', issueTypeButtons());
});

bot.action('menu_check_status', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'check_ticket_number' };
  return ctx.reply('Please enter ticket number:');
});

// ================= BACK =================
bot.action('nav_back_main', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.editMessageText('Main Menu', mainMenuButtons());
});

bot.action('nav_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.reply('Cancelled. Send /start to restart.');
});

// ================= ISSUE HANDLERS =================
bot.action('disp_account_block', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};

  return ctx.reply(
    '👋 Dear Captain, Visit the Hala Home for the Account Block/Suspend. Thanks'
  );
});

bot.action('disp_device_issue', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = {};
  return ctx.reply(
    '⚠️ Please visit Hala Home for Device Issue support. Thanks'
  );
});

bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'profile_update_type' };
  return ctx.editMessageText('Select profile update type:', profileUpdateButtons());
});

// ================= NUMBER UPDATE FIX =================
bot.action('profile_number_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    profile_update_type: 'Number Update',
    step: 'meter_id'
  };

  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('profile_picture_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    profile_update_type: 'Profile Picture Update',
    step: 'meter_id'
  };

  return ctx.reply('Upload picture with White Background and Uniform.');
});

// ================= TEXT FLOW =================
bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const text = ctx.message.text;

  // Meter ID step
  if (ctx.session.step === 'meter_id') {
    ctx.session.meter_id = text;

    if (ctx.session.profile_update_type === 'Number Update') {
      ctx.session = {};

      return ctx.reply(
        '📲 Please click on the link to update number:\n\nhttps://tinyurl.com/2p6spcpb'
      );
    }

    if (ctx.session.profile_update_type === 'Profile Picture Update') {
      ctx.session.step = 'awaiting_profile_picture';
      return ctx.reply('Upload picture in uniform with white background.');
    }
  }

  // fallback safety
  return;
});

// ================= SAFE FALLBACK =================
bot.on('callback_query', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (e) {}
});

// ================= SERVER =================
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  console.log('Server running');

  await bot.telegram.setWebhook(RENDER_URL + WEBHOOK_PATH);
  console.log('Webhook set');
});
