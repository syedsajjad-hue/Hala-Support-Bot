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

bot.use(session());

// ================= MAIN MENU =================
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Create Ticket', 'menu_create')],
    [Markup.button.callback('Check Ticket', 'menu_check')]
  ]);
}

// ================= ISSUE MENU =================
function issueMenu() {
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
  return ctx.reply('Welcome to Hala Captain Support', mainMenu());
});

// ================= CREATE MENU FIX =================
bot.action('menu_create', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { step: 'disposition' };

  try { await ctx.deleteMessage(); } catch {}

  return ctx.reply('Select issue type:', issueMenu());
});

// ================= DEVICE ISSUE =================
bot.action('disp_device_issue', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Please Visit Hala Home for Device Issue. Thanks');
});

// ================= PROFILE UPDATE MENU =================
bot.action('disp_profile_update', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Profile Update',
    step: 'profile_menu'
  };

  return ctx.reply(
    'Select Profile Update Type:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Number Update', 'profile_number')],
      [Markup.button.callback('Profile Picture Update', 'profile_picture')]
    ])
  );
});

// ================= NUMBER UPDATE =================
bot.action('profile_number', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Profile Update',
    profile_type: 'Number Update',
    step: 'meter_id'
  };

  return ctx.reply('Enter Meter ID');
});

// ================= PROFILE PICTURE =================
bot.action('profile_picture', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {
    disposition: 'Profile Update',
    profile_type: 'Profile Picture Update',
    step: 'await_photo'
  };

  return ctx.reply(
    '📸 Please attach picture in uniform with white background. Thanks'
  );
});

// ================= TEXT FLOW =================
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  if (!ctx.session) ctx.session = {};

  // METER ID
  if (ctx.session.step === 'meter_id') {
    ctx.session.meter_id = text;
    ctx.session.step = 'number_update_done';

    return ctx.reply('Meter ID received ✔');
  }

  // NUMBER UPDATE FINAL STEP (NO MOBILE NUMBER ANYMORE)
  if (ctx.session.step === 'number_update_done') {
    ctx.session.mobile_number = null;

    await createTicket(ctx);

    const ticket = ctx.session.last_ticket;

    const url = `https://tinyurl.com/2p6spcpb?ticket=${ticket}&type=number_update`;

    await ctx.reply(
      `📌 Please click on the link to update number:\n${url}\n\n🎫 Ticket: ${ticket}`
    );

    if (process.env.TEAM_CHAT_ID) {
      await bot.telegram.sendMessage(
        process.env.TEAM_CHAT_ID,
        `📌 Number Update Ticket\nTicket: ${ticket}\nLink: ${url}`
      );
    }

    return;
  }
});

// ================= PHOTO HANDLER =================
bot.on('photo', async (ctx) => {
  if (!ctx.session) return;

  if (ctx.session.step === 'await_photo') {
    ctx.session.photo = ctx.message.photo.at(-1).file_id;

    await createTicket(ctx);

    const ticket = ctx.session.last_ticket;

    await ctx.reply(`✅ Profile Picture Ticket Created\n🎫 Ticket: ${ticket}`);

    if (process.env.TEAM_CHAT_ID) {
      await bot.telegram.sendPhoto(
        process.env.TEAM_CHAT_ID,
        ctx.session.photo,
        {
          caption: `Profile Picture Update\nTicket: ${ticket}`
        }
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
        driver_id: ctx.session.meter_id || null,
        description: ctx.session.description || '',
        details_json: {
          profile_type: ctx.session.profile_type || null
        },
        status: 'Pending'
      }
    ])
    .select()
    .single();

  ctx.session.last_ticket = data.ticket_number;

  return data;
}

// ================= SERVER =================
app.get('/', (req, res) => res.send('Bot Running'));

app.listen(PORT, async () => {
  console.log('Server running');

  await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
});

app.use(bot.webhookCallback(WEBHOOK_PATH));
