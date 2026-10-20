const express = require('express');
const http = require('http');

const PORT = 4001;
const BANK = new URL(process.env.BANK_URL || 'http://localhost:4002');
const TOTAL_TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 6;
const MAX_REFUSED = 3;
const NO_CONNECT_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'];

const agent = new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10 });

const debts = { 1: 50000000, 2: 0, 3: 3200000 };
const reserved = {};
const payments = new Map();
let seq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function attempt(payload, key, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    let done = false;
    let timer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const req = http.request(
      {
        hostname: BANK.hostname,
        port: BANK.port,
        path: '/charges',
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': key,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString());
          } catch (e) {
            data = null;
          }
          if (res.statusCode === 201) finish({ kind: 'ok', data });
          else if (res.statusCode >= 500) finish({ kind: 'retry' });
          else finish({ kind: 'rejected', status: res.statusCode, data });
        });
        res.on('error', () => finish({ kind: 'retry' }));
        res.on('close', () => finish({ kind: 'retry' }));
      }
    );

    timer = setTimeout(() => {
      finish({ kind: 'timeout' });
      req.destroy();
    }, timeoutMs);

    req.on('error', (err) => {
      if (NO_CONNECT_CODES.includes(err.code)) finish({ kind: 'noconnect' });
      else finish({ kind: 'retry' });
    });

    req.end(body);
  });
}

async function charge(paymentId, amount) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let uncertain = false;
  let refused = 0;

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      uncertain = true;
      break;
    }

    const r = await attempt({ reference: paymentId, amount }, paymentId, remaining);

    if (r.kind === 'ok') return { outcome: 'paid', data: r.data };
    if (r.kind === 'rejected') return { outcome: 'rejected', status: r.status, data: r.data };

    if (r.kind === 'noconnect') {
      refused++;
      if (refused >= MAX_REFUSED) break;
    } else {
      uncertain = true;
      if (r.kind === 'timeout') break;
    }

    const wait = Math.min(100 * n, deadline - Date.now());
    if (wait > 0) await sleep(wait);
  }

  return { outcome: uncertain ? 'pending' : 'unreachable' };
}

const app = express();
app.use(express.json());

app.get('/students/:id/fees', (req, res) => {
  const id = Number(req.params.id);
  if (debts[id] === undefined) {
    return res.status(404).json({ error: 'STUDENT_NOT_FOUND' });
  }
  res.status(200).json({ studentId: id, debt: debts[id] });
});

app.post('/students/:id/payments', async (req, res) => {
  const id = Number(req.params.id);
  if (debts[id] === undefined) {
    return res.status(404).json({ error: 'STUDENT_NOT_FOUND', paymentId: null, status: 'FAILED' });
  }

  const amount = req.body && req.body.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'INVALID_AMOUNT', paymentId: null, status: 'FAILED' });
  }

  const available = debts[id] - (reserved[id] || 0);
  if (amount > available) {
    return res.status(400).json({ error: 'AMOUNT_EXCEEDS_DEBT', paymentId: null, status: 'FAILED' });
  }

  const paymentId = 'P' + ++seq;
  const payment = { paymentId, studentId: id, amount, status: 'PENDING' };
  payments.set(paymentId, payment);
  reserved[id] = (reserved[id] || 0) + amount;

  const result = await charge(paymentId, amount);
  reserved[id] -= amount;

  if (result.outcome === 'paid') {
    debts[id] -= amount;
    payment.status = 'PAID';
    return res.status(201).json({
      paymentId,
      status: 'PAID',
      chargeId: result.data && result.data.chargeId,
      amount,
    });
  }

  if (result.outcome === 'rejected') {
    payment.status = 'FAILED';
    return res.status(result.status).json({
      error: (result.data && result.data.error) || 'BANK_REJECTED',
      paymentId,
      status: 'FAILED',
    });
  }

  if (result.outcome === 'unreachable') {
    payment.status = 'FAILED';
    return res.status(503).json({ error: 'BANK_UNREACHABLE', paymentId, status: 'FAILED' });
  }

  payment.status = 'PENDING';
  return res.status(504).json({ error: 'BANK_TIMEOUT', paymentId, status: 'PENDING' });
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: 'BAD_REQUEST', paymentId: null, status: 'FAILED' });
});

http.createServer(app).listen(PORT, () => {
  console.log('Fee Service listening on ' + PORT + ' BANK_URL=' + BANK.href);
});
