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

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

bot.use(session());

// ================= MENU =================
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Create Ticket', 'menu_create')],
    [Markup.button.callback('Check Ticket', 'menu_check')]
  ]);
}

function issueMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Payment Issue', 'disp_payment'),
      Markup.button.callback('Account Block', 'disp_account_block')
    ],
    [
      Markup.button.callback('Stuck Booking', 'disp_stuck_booking'),
      Markup.button.callback('Device Issue', 'disp_device')
    ],
    [Markup.button.callback('Profile Update', 'disp_profile')]
  ]);
}

function profileMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Number Update', 'profile_number'),
      Markup.button.callback('Profile Picture', 'profile_pic')
    ]
  ]);
}

function ticketButtons(id) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Assign to Me', `assign_${id}`),
      Markup.button.callback('Resolve', `resolve_${id}`)
    ]
  ]);
}

// ================= START =================
bot.start((ctx) => {
  ctx.session = {};
  return ctx.reply('Welcome to Hala Support', mainMenu());
});

// ================= CREATE FLOW FIX =================
bot.action('menu_create', async (ctx) => {
  await ctx.answerCbQuery();

  // 🔥 FIX: correct flow restored
  ctx.session = { step: 'disposition' };

  return ctx.editMessageText('Select Issue Type:', issueMenu());
});

// ================= DISPOSITIONS =================
bot.action('disp_payment', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { disposition: 'Payment Issue', step: 'meter_id' };
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_account_block', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { disposition: 'Account Block', step: 'meter_id' };
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_stuck_booking', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { disposition: 'Stuck Booking', step: 'meter_id' };
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('disp_device', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply('Please visit Hala Home for Device Issue. Thanks');
});

bot.action('disp_profile', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { disposition: 'Profile Update', step: 'profile_type' };
  return ctx.editMessageText('Select Type:', profileMenu());
});

// ================= PROFILE =================
bot.action('profile_number', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.profile_update_type = 'Number Update';
  ctx.session.step = 'meter_id';
  return ctx.reply('Enter 7-digit Meter ID:');
});

bot.action('profile_pic', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.profile_update_type = 'Profile Picture';
  ctx.session.step = 'meter_id';
  return ctx.reply('Enter 7-digit Meter ID:');
});

// ================= TEXT FLOW =================
bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const text = ctx.message.text;

  if (ctx.session.step === 'meter_id') {
    if (!/^\d{7}$/.test(text)) {
      return ctx.reply('Invalid Meter ID');
    }

    ctx.session.meter_id = text;

    // ================= NUMBER UPDATE FIX =================
    if (
      ctx.session.disposition === 'Profile Update' &&
      ctx.session.profile_update_type === 'Number Update'
    ) {
      await ctx.reply(
        '📲 Please click on the link to update number:\nhttps://tinyurl.com/2p6spcpb'
      );
    }

    return createTicket(ctx);
  }
});

// ================= CREATE TICKET =================
async function createTicket(ctx) {
  try {

    const raw = await getNextTicketNumber();
    const ticketNumber = `Hala-${String(raw).padStart(3, '0')}`;

    const { data, error } = await supabase
      .from('tickets')
      .insert([{
        ticket_number: ticketNumber,
        telegram_user_id: String(ctx.from.id),
        driver_id: ctx.session.meter_id,
        disposition: ctx.session.disposition,
        status: 'Pending',
        priority: 'Medium'
      }])
      .select()
      .single();

    if (error) return ctx.reply('DB error');

    // ================= TEAM QUEUE FIX =================
    const msg =
`🆕 New Ticket

Ticket: ${ticketNumber}
Type: ${ctx.session.disposition}
Meter: ${ctx.session.meter_id}
Status: Pending`;

    if (ctx.session.photo_file_id) {
      await bot.telegram.sendPhoto(
        process.env.TEAM_CHAT_ID,
        ctx.session.photo_file_id,
        {
          caption: msg,
          ...ticketButtons(data.id)
        }
      );
    } else {
      await bot.telegram.sendMessage(
        process.env.TEAM_CHAT_ID,
        msg,
        ticketButtons(data.id)
      );
    }

    ctx.session = {};

    return ctx.reply(`Ticket Created: ${ticketNumber}`);

  } catch (e) {
    console.log(e);
    return ctx.reply('Error creating ticket');
  }
}

// ================= TICKET GENERATOR =================
async function getNextTicketNumber() {
  const { data } = await supabase.rpc('generate_hala_ticket_number');
  return data;
}

// ================= SERVER =================
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
  console.log('Bot running');
});
