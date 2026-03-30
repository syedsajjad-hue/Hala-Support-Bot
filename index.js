require('dotenv').config();

const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

bot.use(session());

function isValidMeterId(value) {
  return /^\d{7}$/.test(value);
}

function ticketButtons(ticketId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Assign to Me', `assign_${ticketId}`),
      Markup.button.callback('Resolve', `resolve_${ticketId}`)
    ]
  ]);
}

bot.start((ctx) => {
  ctx.session = {};
  return ctx.reply(
    'Welcome to Hala Driver Support Bot',
    Markup.keyboard([
      ['Create Ticket', 'Check Ticket Status']
    ]).resize()
  );
});

bot.hears('Create Ticket', (ctx) => {
  ctx.session = { step: 'disposition' };
  return ctx.reply(
    'Select issue type:',
    Markup.keyboard([
      ['Payment Issue', 'Account Block'],
      ['Stuck Booking', 'Device Issue']
    ]).resize()
  );
});

bot.hears('Check Ticket Status', (ctx) => {
  ctx.session = { step: 'check_ticket_number' };
  return ctx.reply('Please enter ticket number:');
});

bot.on('photo', async (ctx) => {
  try {
    if (!ctx.session || ctx.session.step !== 'awaiting_photo') return;

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    ctx.session.photo_file_id = photo.file_id;
    ctx.session.step = 'description';

    return ctx.reply('Enter description:');
  } catch (err) {
    console.log('Photo error:', err);
    return ctx.reply('Error receiving photo');
  }
});

bot.action(/assign_(.+)/, async (ctx) => {
  try {
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
      .single();

    if (error || !data) {
      console.log('Assign button error:', error);
      await ctx.answerCbQuery('Assign failed');
      return;
    }

    await ctx.answerCbQuery('Ticket assigned');

    const newText =
      `New Ticket Created\n\n` +
      `Ticket: ${data.id}\n` +
      `Type: ${data.disposition}\n` +
      `Meter ID: ${data.driver_id}\n` +
      `Priority: ${data.priority}\n` +
      `Assigned: ${agentName}`;

    await ctx.editMessageText(newText, ticketButtons(ticketId));
  } catch (err) {
    console.log('Assign action error:', err);
    await ctx.answerCbQuery('Assign failed');
  }
});

bot.action(/resolve_(.+)/, async (ctx) => {
  try {
    const ticketId = ctx.match[1];

    const { data, error } = await supabase
      .from('tickets')
      .update({
        status: 'Resolved',
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', ticketId)
      .select()
      .single();

    if (error || !data) {
      console.log('Resolve button error:', error);
      await ctx.answerCbQuery('Resolve failed');
      return;
    }

    try {
      await bot.telegram.sendMessage(
        data.telegram_user_id,
        `Your ticket ${ticketId} has been resolved.`
      );
    } catch (notifyErr) {
      console.log('Driver notify error:', notifyErr);
    }

    await ctx.answerCbQuery('Ticket resolved');

    const assignedText = data.assigned_agent || 'Not Assigned';

    const newText =
      `Ticket Resolved\n\n` +
      `Ticket: ${data.id}\n` +
      `Type: ${data.disposition}\n` +
      `Meter ID: ${data.driver_id}\n` +
      `Priority: ${data.priority}\n` +
      `Assigned: ${assignedText}\n` +
      `Status: Resolved`;

    await ctx.editMessageText(newText);
  } catch (err) {
    console.log('Resolve action error:', err);
    await ctx.answerCbQuery('Resolve failed');
  }
});

bot.on('text', async (ctx) => {
  try {
    if (!ctx.session || !ctx.session.step) return;

    const text = ctx.message.text.trim();

    if (ctx.session.step === 'check_ticket_number') {
      const { data, error } = await supabase
        .from('tickets')
        .select('*')
        .eq('id', text)
        .single();

      ctx.session = {};

      if (error || !data) {
        return ctx.reply('Ticket not found.');
      }

      return ctx.reply(
        `Ticket: ${data.id}\nType: ${data.disposition}\nStatus: ${data.status}\nAssigned: ${data.assigned_agent || 'Not Assigned'}`
      );
    }

    if (ctx.session.step === 'disposition') {
      const valid = ['Payment Issue', 'Account Block', 'Stuck Booking', 'Device Issue'];

      if (!valid.includes(text)) {
        return ctx.reply('Please select issue type using buttons.');
      }

      ctx.session.disposition = text;
      ctx.session.step = 'meter_id';
      return ctx.reply('Enter 7-digit Meter ID:');
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
    }

    if (ctx.session.step === 'fare') {
      ctx.session.fare = text;
      ctx.session.step = 'time';
      return ctx.reply('Enter Time:');
    }

    if (ctx.session.step === 'time') {
      ctx.session.time = text;
      ctx.session.step = 'awaiting_photo';
      return ctx.reply('Upload photo now:');
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

    if (ctx.session.step === 'description') {
      ctx.session.description = text;
      return createTicket(ctx);
    }
  } catch (err) {
    console.log('Text error:', err);
    ctx.session = {};
    return ctx.reply('Something went wrong');
  }
});

async function createTicket(ctx) {
  try {
    let priority = 'Medium';

    if (
      ctx.session.disposition === 'Account Block' ||
      ctx.session.disposition === 'Stuck Booking'
    ) {
      priority = 'High';
    }

    const details = {
      meter_id: ctx.session.meter_id,
      fare: ctx.session.fare || null,
      time: ctx.session.time || null,
      car_side_number: ctx.session.car_side_number || null,
      device_id: ctx.session.device_id || null
    };

    const { data, error } = await supabase
      .from('tickets')
      .insert([
        {
          telegram_user_id: String(ctx.from.id),
          driver_id: ctx.session.meter_id,
          disposition: ctx.session.disposition,
          description: ctx.session.description || null,
          details_json: details,
          photo_file_id: ctx.session.photo_file_id || null,
          priority,
          status: 'New',
          updated_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      console.log('Database error:', error);
      ctx.session = {};
      return ctx.reply('Database error');
    }

    try {
      if (process.env.TEAM_CHAT_ID) {
        await bot.telegram.sendMessage(
          process.env.TEAM_CHAT_ID,
          `New Ticket Created\n\n` +
            `Ticket: ${data.id}\n` +
            `Type: ${ctx.session.disposition}\n` +
            `Meter ID: ${ctx.session.meter_id}\n` +
            `Priority: ${priority}\n` +
            `Assigned: Not Assigned`,
          ticketButtons(data.id)
        );
      }
    } catch (notifyErr) {
      console.log('Notification error:', notifyErr);
    }

    ctx.session = {};
    return ctx.reply(`Ticket created: ${data.id}`);
  } catch (err) {
    console.log('Create ticket error:', err);
    ctx.session = {};
    return ctx.reply('Error saving ticket');
  }
}

app.get('/', (req, res) => {
  res.send('Hala Support Bot is running. Open /dashboard');
});

app.get('/dashboard', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .order('id', { ascending: false });

    if (error) {
      console.log('Dashboard error:', error);
      return res.send('Error loading dashboard');
    }

    const total = data.length;
    const open = data.filter(t => t.status !== 'Resolved').length;
    const resolved = data.filter(t => t.status === 'Resolved').length;

    let html = `
    <html>
    <head>
      <title>Hala Support Dashboard</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #3886fc;
          padding: 20px;
        }
        h1 {
          margin-bottom: 20px;
          color: white;
        }
        .cards {
          display: flex;
          gap: 20px;
          margin-bottom: 20px;
        }
        .card {
          background: white;
          padding: 20px;
          border-radius: 10px;
          box-shadow: 0 2px 5px rgba(0,0,0,0.1);
          flex: 1;
          text-align: center;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          background: white;
          border-radius: 10px;
          overflow: hidden;
        }
        th, td {
          padding: 12px;
          border-bottom: 1px solid #ddd;
          text-align: left;
        }
        th {
          background: #2c3e50;
          color: white;
        }
        tr:hover {
          background: #f1f1f1;
        }
      </style>
    </head>
    <body>
      <h1>Hala Support Dashboard</h1>

      <div class="cards">
        <div class="card">
          <h2>${total}</h2>
          <p>Total Tickets</p>
        </div>
        <div class="card">
          <h2>${open}</h2>
          <p>Open Tickets</p>
        </div>
        <div class="card">
          <h2>${resolved}</h2>
          <p>Resolved Tickets</p>
        </div>
      </div>

      <table>
        <tr>
          <th>ID</th>
          <th>Type</th>
          <th>Status</th>
          <th>Agent</th>
          <th>Meter</th>
          <th>Priority</th>
        </tr>
    `;

    data.forEach(t => {
      html += `
        <tr>
          <td>${t.id}</td>
          <td>${t.disposition || '-'}</td>
          <td>${t.status || '-'}</td>
          <td>${t.assigned_agent || '-'}</td>
          <td>${t.driver_id || '-'}</td>
          <td>${t.priority || '-'}</td>
        </tr>
      `;
    });

    html += `
      </table>
    </body>
    </html>
    `;

    res.send(html);
  } catch (err) {
    console.log(err);
    res.send('Error loading dashboard');
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});

bot.launch();
console.log('Bot started');
