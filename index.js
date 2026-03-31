require('dotenv').config();

const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://hala-support-bot.onrender.com';
const WEBHOOK_PATH = '/telegram-webhook';

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is missing');
}

if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL is missing');
}

if (!process.env.SUPABASE_KEY) {
  throw new Error('SUPABASE_KEY is missing');
}

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

function getStatusBadge(status) {
  if (status === 'Resolved') {
    return '<span class="badge status-resolved">Resolved</span>';
  }
  if (status === 'New') {
    return '<span class="badge status-new">New</span>';
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

async function getNextTicketNumber() {
  const { data, error } = await supabase
    .from('tickets')
    .select('ticket_number')
    .not('ticket_number', 'is', null);

  if (error) {
    console.log('Ticket number fetch error:', error);
    return 'HALA-001';
  }

  let maxNumber = 0;

  for (const row of data || []) {
    const value = row.ticket_number;

    // Only accept sequence style like HALA-001, HALA-002, HALA-123
    if (typeof value === 'string' && /^HALA-\d{3}$/.test(value)) {
      const num = parseInt(value.split('-')[1], 10);
      if (!isNaN(num) && num > maxNumber) {
        maxNumber = num;
      }
    }
  }

  const nextNumber = maxNumber + 1;
  return `HALA-${String(nextNumber).padStart(3, '0')}`;
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
      `Ticket: ${data.ticket_number || data.id}\n` +
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
        `Your ticket ${data.ticket_number || ticketId} has been resolved.`
      );
    } catch (notifyErr) {
      console.log('Driver notify error:', notifyErr);
    }

    await ctx.answerCbQuery('Ticket resolved');

    const assignedText = data.assigned_agent || 'Not Assigned';

    const newText =
      `Ticket Resolved\n\n` +
      `Ticket: ${data.ticket_number || data.id}\n` +
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
      const numericPart = text.replace(/\D/g, '');

      const { data, error } = await supabase
        .from('tickets')
        .select('*')
        .or(`ticket_number.eq.${text},id.eq.${numericPart || 0}`)
        .single();

      ctx.session = {};

      if (error || !data) {
        return ctx.reply('Ticket not found.');
      }

      return ctx.reply(
        `Ticket: ${data.ticket_number || data.id}\nType: ${data.disposition}\nStatus: ${data.status}\nAssigned: ${data.assigned_agent || 'Not Assigned'}`
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

    const ticketNumber = await getNextTicketNumber();

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
          ticket_number: ticketNumber,
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
            `Ticket: ${data.ticket_number}\n` +
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
    return ctx.reply(`✅ Ticket created: ${data.ticket_number}`);
  } catch (err) {
    console.log('Create ticket error:', err);
    ctx.session = {};
    return ctx.reply('Error saving ticket');
  }
}

app.get('/', (req, res) => {
  res.send('Bot server is running');
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
    const high = data.filter(t => t.priority === 'High').length;

    let rows = '';

    data.forEach(t => {
      rows += `
        <tr>
          <td>${t.ticket_number || '#' + t.id}</td>
          <td>${t.disposition || '-'}</td>
          <td>${getStatusBadge(t.status)}</td>
          <td>${t.assigned_agent || '-'}</td>
          <td>${t.driver_id || '-'}</td>
          <td>${getPriorityBadge(t.priority)}</td>
        </tr>
      `;
    });

    const html = `
    <html>
    <head>
      <title>Hala Premium Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        * {
          box-sizing: border-box;
        }
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
          opacity: 0.95;
          font-size: 14px;
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
        .panel {
          background: white;
          border-radius: 18px;
          padding: 20px;
          box-shadow: 0 8px 24px rgba(56, 134, 252, 0.10);
          border: 1px solid #e5edff;
        }
        .panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 18px;
        }
        .panel-title {
          font-size: 20px;
          font-weight: 700;
          color: #111827;
        }
        .search-box {
          padding: 12px 14px;
          width: 280px;
          max-width: 100%;
          border: 1px solid #c7d7ff;
          border-radius: 12px;
          outline: none;
          font-size: 14px;
        }
        .search-box:focus {
          border-color: #3886fc;
          box-shadow: 0 0 0 3px rgba(56, 134, 252, 0.12);
        }
        .table-wrap {
          overflow-x: auto;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 760px;
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
        .status-new {
          background: #dbeafe;
          color: #1d4ed8;
        }
        .status-open {
          background: #fef3c7;
          color: #b45309;
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
        @media (max-width: 768px) {
          .topbar {
            padding: 20px;
          }
          .container {
            padding: 16px;
          }
          .panel-header {
            align-items: stretch;
          }
          .search-box {
            width: 100%;
          }
        }
      </style>
    </head>
    <body>
      <div class="topbar">
        <h1>Hala Premium Support Dashboard</h1>
        <p>Live ticket overview and support operations center</p>
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

        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">Ticket List</div>
            <input
              type="text"
              id="searchInput"
              class="search-box"
              placeholder="Search by ticket, type, status, agent, meter..."
              onkeyup="filterTable()"
            />
          </div>

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
        function filterTable() {
          const input = document.getElementById('searchInput');
          const filter = input.value.toLowerCase();
          const table = document.getElementById('ticketTable');
          const tr = table.getElementsByTagName('tr');

          for (let i = 1; i < tr.length; i++) {
            const rowText = tr[i].innerText.toLowerCase();
            tr[i].style.display = rowText.includes(filter) ? '' : 'none';
          }
        }
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

app.use(bot.webhookCallback(WEBHOOK_PATH));

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.telegram.setWebhook(`${RENDER_URL}${WEBHOOK_PATH}`);
    console.log(`Webhook set to ${RENDER_URL}${WEBHOOK_PATH}`);
  } catch (err) {
    console.error('Webhook setup error:', err);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
