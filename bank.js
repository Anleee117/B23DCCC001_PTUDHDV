const express = require('express');
const http = require('http');

const PORT = 4002;
const LIMIT = 20000000;
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const byKey = new Map();
const refCount = new Map();
let seq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = express();
app.use(express.json());

app.get('/stats', (req, res) => {
  res.json(stats);
});

app.post('/charges', async (req, res) => {
  stats.requests++;
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  const key = req.get('Idempotency-Key');
  if (key && byKey.has(key)) {
    return res.status(201).json(byKey.get(key));
  }

  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }

  const { reference, amount } = req.body || {};
  if (typeof reference !== 'string' || reference === '' || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'INVALID_AMOUNT' });
  }
  if (amount > LIMIT) {
    return res.status(402).json({ error: 'LIMIT_EXCEEDED' });
  }

  const count = refCount.get(reference) || 0;
  if (count > 0) stats.duplicates++;
  refCount.set(reference, count + 1);
  stats.charges++;

  const charge = { chargeId: 'C' + ++seq, reference, amount };
  if (key) byKey.set(key, charge);

  if (Math.random() < DROP_RATE) {
    req.socket.destroy();
    return;
  }

  res.status(201).json(charge);
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: 'BAD_REQUEST' });
});

const server = http.createServer(app);

server.on('connection', () => {
  stats.connections++;
  console.log('new TCP connection, total: ' + stats.connections);
});

server.listen(PORT, () => {
  console.log('Bank listening on ' + PORT + ' DELAY_MS=' + DELAY_MS + ' FAIL_RATE=' + FAIL_RATE + ' DROP_RATE=' + DROP_RATE);
});
