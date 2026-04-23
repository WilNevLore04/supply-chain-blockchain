const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// BLOCKCHAIN LOADER
// ─────────────────────────────────────────────

const YEARS = ['2018', '2019', '2020', '2021', '2022'];
const blockchainData = {}; // { year: [block, block, ...] }

function createHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function clean(val) {
  return (val || '').toString().trim();
}

function loadCSV(year) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(__dirname, 'data', `output${year}_final.csv`);
    const results = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        const transaction_id = row.transaction_id || row['\uFEFFtransaction_id'];
        if (!transaction_id) return;

        results.push({
          transaction_id: clean(transaction_id),
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
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

async function loadAllData() {
  for (const year of YEARS) {
    blockchainData[year] = await loadCSV(year);
    console.log(`✅ Loaded ${year}: ${blockchainData[year].length} transactions`);
  }
}

// ─────────────────────────────────────────────
// HELPER: get all blocks across all years
// ─────────────────────────────────────────────
function getAllBlocks() {
  return YEARS.flatMap(year =>
    blockchainData[year].map((tx, idx) => ({ ...tx, year, block_index: idx }))
  );
}

// ─────────────────────────────────────────────
// CHAIN VALIDATOR
// ─────────────────────────────────────────────
function validateChain(chain) {
  const broken = [];
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].previous_hash !== chain[i - 1].current_hash) {
      broken.push(i);
    }
  }
  return { valid: broken.length === 0, brokenAt: broken };
}

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// GET /transaction/:id  — search by transaction_id across all years
app.get('/transaction/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  const all = getAllBlocks();
  const match = all.filter(tx => tx.transaction_id === id);

  if (!match.length) {
    return res.status(404).json({ error: 'Transaction not found', transaction_id: id });
  }

  // Enrich each result with chain-validity context
  const results = match.map(tx => {
    const chain = blockchainData[tx.year];
    const idx = tx.block_index;
    const prevOk = idx === 0 || chain[idx].previous_hash === chain[idx - 1].current_hash;
    const nextOk = idx === chain.length - 1 || chain[idx + 1].previous_hash === chain[idx].current_hash;
    return {
      ...tx,
      chain_integrity: prevOk && nextOk ? 'VALID' : 'BROKEN',
    };
  });

  res.json({ found: results.length, transactions: results });
});

// GET /block/:hash  — search by current_hash
app.get('/block/:hash', (req, res) => {
  const hash = req.params.hash.toLowerCase();
  const all = getAllBlocks();
  const match = all.find(tx => tx.current_hash === hash);

  if (!match) {
    return res.status(404).json({ error: 'Block not found', hash });
  }

  res.json({ block: match });
});

// GET /chain/:year  — full chain for a year
app.get('/chain/:year', (req, res) => {
  const year = req.params.year;
  if (!blockchainData[year]) {
    return res.status(404).json({ error: 'Year not found. Use: 2018-2022' });
  }
  const chain = blockchainData[year];
  const validation = validateChain(chain);
  res.json({ year, total: chain.length, validation, chain });
});

// GET /validate/:year  — validate chain integrity
app.get('/validate/:year', (req, res) => {
  const year = req.params.year;
  if (!blockchainData[year]) {
    return res.status(404).json({ error: 'Year not found' });
  }
  const chain = blockchainData[year];
  const result = validateChain(chain);
  res.json({
    year,
    total_blocks: chain.length,
    status: result.valid ? 'VALID' : 'BROKEN',
    broken_at_indices: result.brokenAt,
    message: result.valid
      ? `Chain ${year} valid — no tampering detected.`
      : `Chain ${year} broken at ${result.brokenAt.length} point(s).`
  });
});

// GET /stats  — summary stats across all years
app.get('/stats', (req, res) => {
  const stats = YEARS.map(year => {
    const chain = blockchainData[year];
    const totalVolume = chain.reduce((sum, tx) => sum + parseFloat(tx.volume || 0), 0);
    const countries = [...new Set(chain.map(tx => tx.country))];
    const exporters = [...new Set(chain.map(tx => tx.exporter))];
    const { valid } = validateChain(chain);
    return {
      year,
      total_transactions: chain.length,
      total_volume: Math.round(totalVolume * 100) / 100,
      unique_countries: countries.length,
      unique_exporters: exporters.length,
      chain_status: valid ? 'VALID' : 'BROKEN',
    };
  });
  res.json({ stats });
});

// GET /search?q=...  — search across exporter/importer/country
app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const year = req.query.year || null;

  if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

  const pool = year && blockchainData[year]
    ? blockchainData[year].map((tx, idx) => ({ ...tx, year, block_index: idx }))
    : getAllBlocks();

  const results = pool.filter(tx =>
    tx.exporter.toLowerCase().includes(q) ||
    tx.importer.toLowerCase().includes(q) ||
    tx.country.toLowerCase().includes(q) ||
    tx.batch_id.toLowerCase().includes(q)
  );

  res.json({ query: q, year: year || 'all', found: results.length, results });
});

// ─────────────────────────────────────────────
// SERVE FRONTEND
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
loadAllData().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Supply Chain Blockchain Explorer`);
    console.log(`   Running at http://localhost:${PORT}`);
    console.log(`\n📡 API Endpoints:`);
    console.log(`   GET /transaction/:id`);
    console.log(`   GET /block/:hash`);
    console.log(`   GET /chain/:year`);
    console.log(`   GET /validate/:year`);
    console.log(`   GET /stats`);
    console.log(`   GET /search?q=...&year=...`);
  });
}).catch(err => {
  console.error('❌ Failed to load data:', err);
  process.exit(1);
});
