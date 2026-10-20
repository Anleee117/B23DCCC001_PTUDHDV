const FEE = 'http://localhost:4001';
const BANK = 'http://localhost:4002';
const mode = process.argv[2];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pay(id, amount) {
  const t = Date.now();
  const r = await fetch(FEE + '/students/' + id + '/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body, ms: Date.now() - t };
}

async function fees(id) {
  const t = Date.now();
  const r = await fetch(FEE + '/students/' + id + '/fees');
  const body = await r.json().catch(() => null);
  return { status: r.status, body, ms: Date.now() - t };
}

const stats = () => fetch(BANK + '/stats').then((r) => r.json());

async function pool(total, concurrency, fn) {
  const out = [];
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < total) {
      const k = next++;
      out[k] = await fn(k);
    }
  });
  await Promise.all(workers);
  return out;
}

async function scenario1() {
  console.log('payment', await pay(1, 100000));
  console.log('fees', await fees(1));
}

async function scenario2() {
  console.log('single payment', await pay(1, 100000));
  const payments = Array.from({ length: 20 }, () => pay(1, 100000));
  await sleep(300);
  console.log('fees while 20 pending', await fees(1));
  const results = await Promise.all(payments);
  console.log('max ms', Math.max(...results.map((r) => r.ms)));
  console.log('statuses', results.map((r) => r.status + '/' + (r.body && r.body.status)).join(' '));
}

async function scenario3() {
  console.log('stats before', await stats());
  const t = Date.now();
  const results = await pool(200, 10, () => pay(1, 1000));
  console.log('total ms', Date.now() - t);
  console.log('success', results.filter((r) => r.status === 201).length + '/200');
  console.log('stats after', await stats());
  await sleep(6000);
  const more = await pool(5, 1, () => pay(1, 1000));
  console.log('after idle', more.map((r) => r.status).join(' '));
  console.log('stats final', await stats());
}

async function scenario4() {
  const before = (await fees(1)).body.debt;
  const results = await pool(60, 1, () => pay(1, 1000));
  const paid = results.filter((r) => r.status === 201).length;
  const pending = results.filter((r) => r.status === 504 && r.body && r.body.status === 'PENDING').length;
  const other = results.filter((r) => r.status !== 201 && !(r.status === 504 && r.body && r.body.status === 'PENDING')).length;
  const after = (await fees(1)).body.debt;
  console.log('PAID', paid, 'PENDING', pending, 'other', other);
  console.log('max ms', Math.max(...results.map((r) => r.ms)));
  console.log('debt reduced', before - after, 'expected', paid * 1000);
  console.log('stats', await stats());
}

async function scenario4c() {
  const before = await stats();
  console.log('payment', await pay(1, 25000000));
  const after = await stats();
  console.log('bank requests delta', after.requests - before.requests);
}

const modes = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4, c: scenario4c };

if (!modes[mode]) {
  console.log('usage: node load.js <1|2|3|4|c>');
  process.exit(1);
}

modes[mode]().catch((err) => {
  console.error(err);
  process.exit(1);
});
