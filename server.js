const express = require('express');
const fs      = require('fs');
const path    = require('path');
const csv     = require('csv-parser');
const crypto  = require('crypto');

const app  = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
//  BLOCKCHAIN CORE
// ══════════════════════════════════════════════════════

const YEARS          = ['2018', '2019', '2020', '2021', '2022'];
const originalData   = {};   // immutable — loaded from CSV
const workingData    = {};   // mutable   — tamper simulation runs here
const tamperedBlocks = {};   // { year: Set<index> }

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
function clean(val) { return (val || '').toString().trim(); }

function computeHash(tx, previousHash) {
  const s = [
    tx.transaction_id, tx.batch_id, tx.exporter,
    tx.importer, tx.port, tx.country,
    tx.volume, tx.created_at, previousHash
  ].join('');
  return sha256(s);
}

function loadCSV(year) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(path.join(__dirname, 'data', `output${year}_final.csv`))
      .pipe(csv())
      .on('data', row => {
        const id = clean(row.transaction_id || row['\uFEFFtransaction_id']);
        if (!id) return;
        results.push({
          transaction_id: id,
          batch_id:       clean(row.batch_id),
          exporter:       clean(row.exporter),
          importer:       clean(row.importer),
          port:           clean(row.port),
          country:        clean(row.country),
          volume:         clean(row.volume),
          created_at:     clean(row.created_at),
          shipped_at:     clean(row.shipped_at),
          received_at:    clean(row.received_at),
          status:         clean(row.status),
          previous_hash:  clean(row.previous_hash),
          current_hash:   clean(row.current_hash),
        });
      })
      .on('end',   () => resolve(results))
      .on('error', reject);
  });
}

async function loadAllData() {
  for (const year of YEARS) {
    const chain = await loadCSV(year);
    originalData[year]   = chain;
    workingData[year]    = chain.map(tx => ({ ...tx }));
    tamperedBlocks[year] = new Set();
    console.log(`[${year}] ${chain.length} blocks loaded`);
  }
}

function validateChain(chain) {
  const broken = [];
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].previous_hash !== chain[i - 1].current_hash) broken.push(i);
  }
  return { valid: broken.length === 0, brokenAt: broken };
}

function annotateChain(year) {
  const chain     = workingData[year];
  const tampered  = tamperedBlocks[year];
  const { brokenAt } = validateChain(chain);
  const brokenSet = new Set(brokenAt);

  return chain.map((tx, i) => ({
    ...tx,
    year,
    block_index:       i,
    is_tampered:       tampered.has(i),
    chain_link_broken: brokenSet.has(i),
    original_volume:   originalData[year][i].volume,
  }));
}

// ══════════════════════════════════════════════════════
//  READ ENDPOINTS
// ══════════════════════════════════════════════════════

app.get('/transaction/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  const matches = [];
  for (const year of YEARS)
    annotateChain(year).forEach(tx => { if (tx.transaction_id === id) matches.push(tx); });
  if (!matches.length) return res.status(404).json({ error: 'Not found', transaction_id: id });
  res.json({ found: matches.length, transactions: matches });
});

app.get('/block/:hash', (req, res) => {
  const hash = req.params.hash.toLowerCase();
  for (const year of YEARS) {
    const tx = annotateChain(year).find(t => t.current_hash === hash);
    if (tx) return res.json({ block: tx });
  }
  res.status(404).json({ error: 'Block not found' });
});

app.get('/chain/:year', (req, res) => {
  const { year } = req.params;
  if (!workingData[year]) return res.status(404).json({ error: 'Year not found (2018-2022)' });
  const chain      = annotateChain(year);
  const validation = validateChain(workingData[year]);
  res.json({ year, total: chain.length, validation, chain });
});

app.get('/validate/:year', (req, res) => {
  const { year } = req.params;
  if (!workingData[year]) return res.status(404).json({ error: 'Year not found' });
  const chain  = workingData[year];
  const result = validateChain(chain);
  res.json({
    year,
    total_blocks:      chain.length,
    tampered_count:    tamperedBlocks[year].size,
    status:            result.valid ? 'VALID' : 'BROKEN',
    broken_at_indices: result.brokenAt,
    message: result.valid
      ? `Chain ${year} VALID — tidak ada manipulasi terdeteksi.`
      : `Chain ${year} RUSAK — ${result.brokenAt.length} link putus.`
  });
});

app.get('/stats', (_req, res) => {
  const stats = YEARS.map(year => {
    const chain     = workingData[year];
    const vol       = chain.reduce((s, t) => s + parseFloat(t.volume || 0), 0);
    const { valid } = validateChain(chain);
    return {
      year,
      total_transactions: chain.length,
      total_volume:       Math.round(vol * 100) / 100,
      unique_countries:   new Set(chain.map(t => t.country)).size,
      unique_exporters:   new Set(chain.map(t => t.exporter)).size,
      tampered_count:     tamperedBlocks[year].size,
      chain_status:       valid ? 'VALID' : 'BROKEN',
    };
  });
  res.json({ stats });
});

app.get('/search', (req, res) => {
  const q     = (req.query.q || '').toLowerCase().trim();
  const year  = req.query.year || null;
  const field = req.query.field || 'all';
  if (!q) return res.status(400).json({ error: 'q is required' });

  const years   = year && workingData[year] ? [year] : YEARS;
  const results = [];

  years.forEach(y => {
    annotateChain(y).forEach(tx => {
      const hit =
        field === 'exporter'       ? tx.exporter.toLowerCase().includes(q) :
        field === 'importer'       ? tx.importer.toLowerCase().includes(q) :
        field === 'country'        ? tx.country.toLowerCase().includes(q)  :
        field === 'transaction_id' ? tx.transaction_id.toLowerCase().includes(q) :
        tx.exporter.toLowerCase().includes(q) ||
        tx.importer.toLowerCase().includes(q) ||
        tx.country.toLowerCase().includes(q)  ||
        tx.batch_id.toLowerCase().includes(q) ||
        tx.transaction_id.toLowerCase().includes(q);
      if (hit) results.push(tx);
    });
  });

  res.json({ query: q, year: year || 'all', field, found: results.length, results });
});

// ══════════════════════════════════════════════════════
//  CREATE TRANSACTION
// ══════════════════════════════════════════════════════

// POST /transaction  { year, transaction_id, batch_id, exporter, importer, port, country, volume, created_at, shipped_at, received_at, status }
app.post('/transaction', (req, res) => {
  const { year, ...fields } = req.body;
  if (!YEARS.includes(year)) return res.status(400).json({ error: `Year must be one of: ${YEARS.join(', ')}` });

  const required = ['transaction_id','batch_id','exporter','importer','port','country','volume','created_at'];
  const missing  = required.filter(k => !fields[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  const chain = workingData[year];

  // Check duplicate transaction_id in this year
  if (chain.find(tx => tx.transaction_id === fields.transaction_id.trim())) {
    return res.status(400).json({ error: `Transaction ID "${fields.transaction_id}" already exists in chain ${year}` });
  }

  const previousHash = chain.length > 0 ? chain[chain.length - 1].current_hash : '0';

  const newTx = {
    transaction_id: clean(fields.transaction_id),
    batch_id:       clean(fields.batch_id),
    exporter:       clean(fields.exporter),
    importer:       clean(fields.importer),
    port:           clean(fields.port),
    country:        clean(fields.country),
    volume:         clean(fields.volume),
    created_at:     clean(fields.created_at),
    shipped_at:     clean(fields.shipped_at  || ''),
    received_at:    clean(fields.received_at || ''),
    status:         clean(fields.status      || 'PENDING'),
    previous_hash:  previousHash,
    current_hash:   '',
  };

  // Generate hash
  newTx.current_hash = computeHash(newTx, previousHash);

  // Append to working chain (and original so it persists across restores for new blocks)
  chain.push(newTx);
  originalData[year].push({ ...newTx });

  res.json({
    message:     `Transaksi berhasil ditambahkan ke chain ${year}.`,
    year,
    block_index: chain.length - 1,
    transaction: newTx,
  });
});

// ══════════════════════════════════════════════════════
//  TAMPER SIMULATION ENDPOINTS
// ══════════════════════════════════════════════════════

const ALLOWED_FIELDS = ['volume', 'exporter', 'importer', 'country', 'port', 'status'];

// POST /tamper/random/:year
app.post('/tamper/random/:year', (req, res) => {
  const { year } = req.params;
  if (!workingData[year]) return res.status(404).json({ error: 'Year not found' });

  const chain   = workingData[year];
  const idx     = Math.floor(Math.random() * chain.length);
  const block   = chain[idx];
  const oldVol  = block.volume;
  const oldHash = block.current_hash;

  block.volume       = (parseFloat(oldVol) * 1.5 + 77).toFixed(2);
  block.current_hash = computeHash(block, block.previous_hash);
  tamperedBlocks[year].add(idx);

  const { brokenAt } = validateChain(chain);

  res.json({
    message:        `Block #${idx + 1} di-tamper (volume diubah).`,
    tampered_index: idx,
    year,
    changes: { field: 'volume', old_value: oldVol, new_value: block.volume, old_hash: oldHash, new_hash: block.current_hash },
    chain_impact: { broken_links: brokenAt.length, broken_at: brokenAt, downstream_affected: brokenAt.filter(i => i > idx).length }
  });
});

// POST /tamper/:year/:index  { field, value }
app.post('/tamper/:year/:index', (req, res) => {
  const { year, index } = req.params;
  const idx = parseInt(index, 10);
  if (!workingData[year]) return res.status(404).json({ error: 'Year not found' });
  if (isNaN(idx) || idx < 0 || idx >= workingData[year].length)
    return res.status(400).json({ error: 'Invalid index' });

  const { field, value } = req.body;
  if (!ALLOWED_FIELDS.includes(field))
    return res.status(400).json({ error: `field must be one of: ${ALLOWED_FIELDS.join(', ')}` });

  const block   = workingData[year][idx];
  const oldVal  = block[field];
  const oldHash = block.current_hash;

  block[field]       = value;
  block.current_hash = computeHash(block, block.previous_hash);
  tamperedBlocks[year].add(idx);

  const { brokenAt } = validateChain(workingData[year]);

  res.json({
    message:        `Block #${idx + 1} (${year}) di-tamper.`,
    tampered_index: idx,
    year,
    changes: { field, old_value: oldVal, new_value: value, old_hash: oldHash, new_hash: block.current_hash },
    chain_impact: { broken_links: brokenAt.length, broken_at: brokenAt, downstream_affected: brokenAt.filter(i => i > idx).length }
  });
});

// POST /restore/:year
app.post('/restore/:year', (req, res) => {
  const { year } = req.params;
  if (!originalData[year]) return res.status(404).json({ error: 'Year not found' });
  workingData[year]    = originalData[year].map(tx => ({ ...tx }));
  tamperedBlocks[year] = new Set();
  res.json({ message: `Chain ${year} di-restore ke data asli.`, year, status: 'VALID' });
});

// POST /restore/all
app.post('/restore/all', (_req, res) => {
  YEARS.forEach(year => {
    workingData[year]    = originalData[year].map(tx => ({ ...tx }));
    tamperedBlocks[year] = new Set();
  });
  res.json({ message: 'Semua chain di-restore.', years: YEARS });
});

// ══════════════════════════════════════════════════════
//  CREATE TRANSACTION
// ══════════════════════════════════════════════════════

// POST /transaction  { year, transaction_id, batch_id, exporter, importer, port, country, volume, created_at, shipped_at, received_at, status }
app.post('/transaction', (req, res) => {
  const { year, transaction_id, batch_id, exporter, importer, port, country, volume, created_at, shipped_at, received_at, status } = req.body;

  if (!workingData[year]) return res.status(400).json({ error: 'year harus antara 2018-2022' });

  const required = { year, transaction_id, batch_id, exporter, importer, port, country, volume, created_at };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return res.status(400).json({ error: `Field wajib kosong: ${missing.join(', ')}` });

  const chain        = workingData[year];
  const previous_hash = chain.length ? chain[chain.length - 1].current_hash : '0';

  const newTx = {
    transaction_id: clean(transaction_id),
    batch_id:       clean(batch_id),
    exporter:       clean(exporter),
    importer:       clean(importer),
    port:           clean(port),
    country:        clean(country),
    volume:         clean(volume),
    created_at:     clean(created_at),
    shipped_at:     clean(shipped_at || ''),
    received_at:    clean(received_at || ''),
    status:         clean(status || 'PENDING'),
    previous_hash,
    current_hash:   '',
  };

  newTx.current_hash = computeHash(newTx, previous_hash);

  chain.push(newTx);
  originalData[year].push({ ...newTx });
  tamperedBlocks[year]; // keep existing tamper state

  res.status(201).json({
    message:       `Transaksi ${newTx.transaction_id} berhasil ditambahkan ke chain ${year}.`,
    block_index:   chain.length - 1,
    year,
    transaction:   { ...newTx, block_index: chain.length - 1, is_tampered: false, chain_link_broken: false },
  });
});

// GET /tamper/status/:year
app.get('/tamper/status/:year', (req, res) => {
  const { year } = req.params;
  if (!workingData[year]) return res.status(404).json({ error: 'Year not found' });
  const { valid, brokenAt } = validateChain(workingData[year]);
  res.json({ year, tampered_indices: [...tamperedBlocks[year]], tampered_count: tamperedBlocks[year].size, chain_valid: valid, broken_at: brokenAt });
});

// ══════════════════════════════════════════════════════
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

loadAllData().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀  http://localhost:${PORT}\n`);
    console.log('READ   GET  /transaction/:id');
    console.log('       GET  /chain/:year');
    console.log('       GET  /validate/:year');
    console.log('       GET  /stats');
    console.log('       GET  /search?q=&year=&field=');
    console.log('TAMPER POST /tamper/random/:year');
    console.log('       POST /tamper/:year/:index  {field,value}');
    console.log('       POST /restore/:year');
    console.log('       POST /restore/all');
  });
}).catch(err => { console.error('❌', err); process.exit(1); });