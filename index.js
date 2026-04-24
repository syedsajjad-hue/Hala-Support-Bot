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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ================= GOOGLE SHEETS =================
const sheetsAuth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

// ================= SESSION =================
bot.use(session());

// ================= ENV FORM URL =================
const PROFILE_FORM_URL = process.env.PROFILE_UPDATE_FORM_URL || 'https://example.com/form';

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
        [Markup.button.callback('Profile Update', 'disp_profile_update')],
        [Markup.button.callback('Back', 'nav_back_main'), Markup.button.callback('Cancel', 'nav_cancel')]
    ]);
}

function profileUpdateButtons() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('Number Update', 'profile_number_update'),
            Markup.button.callback('Profile Picture Update', 'profile_picture_update')
        ],
        [Markup.button.callback('Back', 'menu_create_ticket'), Markup.button.callback('Cancel', 'nav_cancel')]
    ]);
}

// ================= PROFILE UPDATE FIX =================
bot.action('disp_profile_update', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { disposition: 'Profile Update', step: 'profile_update_type' };
    return ctx.editMessageText('Select profile update type:', profileUpdateButtons());
});

// ✅ FIXED NUMBER UPDATE FLOW
bot.action('profile_number_update', async (ctx) => {
    await ctx.answerCbQuery();

    ctx.session = {
        disposition: 'Profile Update',
        profile_update_type: 'Number Update',
        step: 'meter_id'
    };

    try { await ctx.deleteMessage(); } catch (e) {}

    return ctx.reply(
        `📌 Profile Number Update Selected\n\n` +
        `Step 1: Enter your 7-digit Meter ID\n\n` +
        `🔗 Please click the link for number update:\n${PROFILE_FORM_URL}`
    );
});

// ================= PROFILE PICTURE =================
bot.action('profile_picture_update', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = {
        disposition: 'Profile Update',
        profile_update_type: 'Profile Picture Update',
        step: 'meter_id'
    };

    try { await ctx.deleteMessage(); } catch (e) {}

    return ctx.reply('Enter 7-digit Meter ID:');
});

// ================= CREATE TICKET (SHORTENED SAFE PLACEHOLDER) =================
async function createTicket(ctx) {
    try {
        let priority = 'Medium';

        const ticketNumber = 'HALA-' + Date.now();

        const { data, error } = await supabase
            .from('tickets')
            .insert([{ 
                ticket_number: ticketNumber,
                telegram_user_id: String(ctx.from.id),
                driver_id: ctx.session.meter_id,
                disposition: ctx.session.disposition,
                description: ctx.session.description || null,
                priority,
                status: 'Pending'
            }])
            .select()
            .single();

        if (error) return ctx.reply('Error creating ticket');

        ctx.session = {};

        return ctx.reply(`Ticket Created: ${data.ticket_number}`);

    } catch (e) {
        console.log(e);
        return ctx.reply('Error');
    }
}

// ================= BOT START =================
bot.start(async (ctx) => {
    return ctx.reply('Welcome', mainMenuButtons());
});

// ================= WEBHOOK =================
app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
    console.log('Server running');
    await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
});
