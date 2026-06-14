require('dotenv').config();
// console.log(process.env.DUMAI_KEY); buat cek apakah di detect keynya 
const express = require('express');
const fs = require('fs');

if (!fs.existsSync('data/raw')) {
  fs.mkdirSync('data/raw');
}

if (!fs.existsSync('data/blockchain')) {
  fs.mkdirSync('data/blockchain');
}
const path = require('path');
const csv = require('csv-parser');
const crypto = require('crypto');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'data/raw/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {

    if (!file.originalname.endsWith('.csv')) {
      return cb(new Error('Only CSV allowed'));
    }

    cb(null, true);
  }
});

const app = express();
const PORT = 3000;

// 🔥 POA AUTHORITY LIST
const AUTHORITIES = {

  [process.env.DUMAI_KEY]:
    'PORT_DUMAI',

  [process.env.BELAWAN_KEY]:
    'PORT_BELAWAN',

  [process.env.GRESIK_KEY]:
    'PORT_GRESIK',

  [process.env.PRIOK_KEY]:
    'PORT_TANJUNG_PRIOK',

  [process.env.PERAK_KEY]:
    'PORT_TANJUNG_PERAK'

};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
//  BLOCKCHAIN CORE
// ══════════════════════════════════════════════════════

const YEARS = ['2018', '2019', '2020', '2021', '2022'];
const originalData = {};   // immutable — loaded from CSV
const workingData = {};   // mutable   — tamper simulation runs here
const tamperedBlocks = {};   // { year: Set<index> }
const tamperDetails = {};

YEARS.forEach(year => {
  workingData[year] = [];
  originalData[year] = [];
  tamperedBlocks[year] = new Set();
  tamperDetails[year] = {};
});

function normalize(val) {
  return (val || '').toString().trim().toUpperCase();
}


function clean(val) { return (val || '').toString().trim(); }

function computeHash(tx, previous_hash) {
  const str = [
    tx.transaction_id,
    tx.exporter,
    tx.importer,
    tx.port,
    tx.country,
    Number(tx.volume),

    tx.created_at,
    tx.shipped_at || '',
    tx.received_at || '',

    tx.status,

    // 🔥 validator PoA
    tx.validator,

    // 🔥 metadata block
    tx.block_timestamp,

    // 🔥 optional
    tx.block_index ?? '',

    previous_hash

  ].join('|');

  return crypto.createHash('sha256').update(str).digest('hex');
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
          transaction_id: id.toUpperCase(),
          exporter: clean(row.exporter),
          importer: clean(row.importer),
          port: clean(row.port),
          country: clean(row.country),
          volume: parseFloat(row.volume) || 0,
          created_at: clean(row.created_at),
          shipped_at: clean(row.shipped_at),
          received_at: clean(row.received_at),
          status: clean(row.status),
          previous_hash: clean(row.previous_hash),
          current_hash: clean(row.current_hash),
        });
      })
      .on('end', () => {

        // 🔥 REBUILD HASH DARI NOL (JANGAN PERCAYA CSV)
        for (let i = 0; i < results.length; i++) {
          const prev = i === 0 ? '0' : results[i - 1].current_hash;

          results[i].previous_hash = prev;
          results[i].current_hash = computeHash(results[i], prev);
        }

        resolve(results);
      })
      .on('error', reject);
  });
}

function validateChain(chain) {

  const broken = [];

  for (let i = 0; i < chain.length; i++) {

    const tx = chain[i];

    const expectedPrev =
      i === 0
        ? '0'
        : chain[i - 1].current_hash;

    // cek linkage
    if (tx.previous_hash !== expectedPrev) {
      broken.push(i);
      continue;
    }

    // 🔥 recompute hash
    const recalculated = computeHash(tx, tx.previous_hash);

    if (tx.current_hash !== recalculated) {
      broken.push(i);
    }
  }

  return {
    valid: broken.length === 0,
    brokenAt: broken
  };
}

function saveChainToFile(year) {

  // buat folder data kalau belum ada
  if (!fs.existsSync('data')) {
    fs.mkdirSync('data');
  }

  const filePath = `data/blockchain/blockchain_${year}.json`;

  fs.writeFileSync(
    filePath,
    JSON.stringify(workingData[year], null, 2)
  );
}

function loadChains() {

  if (!fs.existsSync('data')) return;

  const files = fs.readdirSync('data/blockchain');

  files.forEach(file => {

    if (!file.startsWith('blockchain_')) return;

    const yearMatch = file.match(/\d{4}/);

    if (!yearMatch) return;

    const year = yearMatch[0];

    const raw = fs.readFileSync(`data/blockchain/${file}`);

    const parsed = JSON.parse(raw);

    workingData[year] = parsed;

    originalData[year] = parsed.map(tx => ({ ...tx }));

    tamperedBlocks[year] = new Set();
  });

  console.log('✅ Blockchain JSON loaded');
}

function annotateChain(year) {
  const chain = workingData[year];
  const tampered = tamperedBlocks[year];
  const { brokenAt } = validateChain(chain);
  const brokenSet = new Set(brokenAt);

  return chain.map((tx, i) => ({
    ...tx,
    year,
    block_index: i,
    is_tampered: tampered.has(i),
    chain_link_broken: brokenSet.has(i),

    original_volume:
      originalData[year][i]?.volume ?? tx.volume,

    tamper_info:
      tamperDetails[year][i] || null
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
  const chain = annotateChain(year);
  const validation = validateChain(workingData[year]);
  res.json({ year, total: chain.length, validation, chain });
});

app.get('/validate/:year', (req, res) => {
  const { year } = req.params;
  if (!workingData[year]) return res.status(404).json({ error: 'Year not found' });
  const chain = workingData[year];
  const result = validateChain(chain);
  res.json({
    year,
    total_blocks: chain.length,
    tampered_count: tamperedBlocks[year].size,
    status: result.valid ? 'VALID' : 'BROKEN',
    broken_at_indices: result.brokenAt,
    message: result.valid
      ? `Chain ${year} VALID — tidak ada manipulasi terdeteksi.`
      : `Chain ${year} RUSAK — ${result.brokenAt.length} link putus.`
  });
});

app.get('/stats', (_req, res) => {
  const stats = YEARS.map(year => {
    const chain = workingData[year];
    const vol = chain.reduce((s, t) => s + parseFloat(t.volume || 0), 0);
    const { valid } = validateChain(chain);
    return {
      year,
      total_transactions: chain.length,
      total_volume: Math.round(vol * 100) / 100,
      unique_countries: new Set(chain.map(t => t.country)).size,
      unique_exporters: new Set(chain.map(t => t.exporter)).size,
      tampered_count: tamperedBlocks[year].size,
      chain_status: valid ? 'VALID' : 'BROKEN',
    };
  });
  res.json({ stats });
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const year = req.query.year || null;
  const field = req.query.field || 'all';
  if (!q) return res.status(400).json({ error: 'q is required' });

  const years = year && workingData[year] ? [year] : YEARS;
  const results = [];

  years.forEach(y => {
    annotateChain(y).forEach(tx => {
      const hit =
        field === 'exporter' ? tx.exporter.toLowerCase().includes(q) :
          field === 'importer' ? tx.importer.toLowerCase().includes(q) :
            field === 'country' ? tx.country.toLowerCase().includes(q) :
              field === 'transaction_id' ? tx.transaction_id.toLowerCase().includes(q) :
                tx.exporter.toLowerCase().includes(q) ||
                tx.importer.toLowerCase().includes(q) ||
                tx.country.toLowerCase().includes(q) ||
                tx.transaction_id.toLowerCase().includes(q);
      if (hit) results.push(tx);
    });
  });

  res.json({ query: q, year: year || 'all', field, found: results.length, results });
});


// ══════════════════════════════════════════════════════
//  TAMPER SIMULATION ENDPOINTS
// ══════════════════════════════════════════════════════

const ALLOWED_FIELDS = ['volume', 'exporter', 'importer', 'country', 'port', 'status'];

// POST /tamper/random/:year
app.post('/tamper/random/:year', (req, res) => {
  const { year } = req.params;
  if (!workingData[year]) {
    return res.status(404).json({ error: 'Year not found' });
  }

  const chain = workingData[year];

  if (!chain.length) {
    return res.status(400).json({ error: 'Chain kosong, upload data dulu' });
  }
  const idx = Math.floor(Math.random() * chain.length)
  const block = chain[idx];
  const oldVol = parseFloat(block.volume);
  const oldHash = block.current_hash;

  block.volume = parseFloat((oldVol * 1.5 + 77).toFixed(2));

  //quick tamper
  if (!tamperDetails[year][idx]) {
    tamperDetails[year][idx] = [];
  }

  tamperDetails[year][idx].push({
    field: 'volume',
    old_value: oldVol,
    new_value: block.volume,
    timestamp: new Date().toISOString()
  });

  // ❌ JANGAN regenerate hash
  tamperedBlocks[year].add(idx);

  const { brokenAt } = validateChain(chain);

  res.json({
    message: `Block #${idx + 1} di-tamper (volume diubah).`,
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

  const block = workingData[year][idx];
  const oldVal = block[field];
  const oldHash = block.current_hash;

  if (field === 'volume') {
    block[field] = parseFloat(value);
  } else {
    block[field] = value;
  }
  // manual tamper
  if (!tamperDetails[year][idx]) {
    tamperDetails[year][idx] = [];
  }

  tamperDetails[year][idx].push({
    field,
    old_value: oldVal,
    new_value: value,
    timestamp: new Date().toISOString()
  });

  //  ❌ jangan regenerate hash
  tamperedBlocks[year].add(idx);

  const { brokenAt } = validateChain(workingData[year]);

  res.json({
    message: `Block #${idx + 1} (${year}) di-tamper.`,
    tampered_index: idx,
    year,
    changes: { field, old_value: oldVal, new_value: value, old_hash: oldHash, new_hash: block.current_hash },
    chain_impact: { broken_links: brokenAt.length, broken_at: brokenAt, downstream_affected: brokenAt.filter(i => i > idx).length }
  });
});

// POST /restore/all
app.post('/restore/all', (_req, res) => {
  YEARS.forEach(year => {
    workingData[year] = originalData[year].map(tx => ({ ...tx }));
    tamperedBlocks[year] = new Set();
    tamperDetails[year] = {};
    saveChainToFile(year)
  });
  res.json({ message: 'Semua chain di-restore.', years: YEARS });
});

// POST /restore/:year
app.post('/restore/:year', (req, res) => {
  const { year } = req.params;
  if (!originalData[year]) return res.status(404).json({ error: 'Year not found' });
  workingData[year] = originalData[year].map(tx => ({ ...tx }));
  tamperedBlocks[year] = new Set();
  tamperDetails[year] = {};
  saveChainToFile(year)
  res.json({ message: `Chain ${year} di-restore ke data asli.`, year, status: 'VALID' });
});



// ══════════════════════════════════════════════════════
//  CREATE TRANSACTION
// ══════════════════════════════════════════════════════

app.post('/transaction', (req, res) => {

  // 🔥 AMBIL API KEY
  const apiKey = req.headers['x-api-key'];

  // 🔥 CEK AUTHORITY
  const authority = AUTHORITIES[apiKey];

  if (!authority) {
    return res.status(403).json({
      error: 'Unauthorized API Key'
    });
  }


  // 🔥 AMBIL DATA BODY
  const {
    year,
    transaction_id,
    exporter,
    importer,
    port,
    country,
    volume,
    created_at,
    shipped_at,
    received_at,
    status
  } = req.body;


  // 🔥 VALIDASI PORT
  const validatorPort =
    authority.replace('PORT_', '').replaceAll('_', ' ');

  if (normalize(port) !== normalize(validatorPort)) {
    return res.status(403).json({
      error: `API key tidak sesuai untuk port ${port}`
    });
  }

  // 🔥 VALIDASI VOLUME
  const vol = Number(volume);

  if (isNaN(vol)) {
    return res.status(400).json({
      error: 'Volume harus angka valid'
    });
  }

  // 🔥 VALIDASI YEAR
  if (!workingData[year]) {
    return res.status(400).json({
      error: 'year harus antara 2018-2022'
    });
  }

  // 🔥 VALIDASI FIELD WAJIB
  const required = {
    year,
    transaction_id,
    exporter,
    importer,
    port,
    country,
    volume,
    created_at
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    return res.status(400).json({
      error: `Field wajib kosong: ${missing.join(', ')}`
    });
  }

  const chain = workingData[year];

  // 🔥 DUPLICATE CHECK
  const txId = normalize(transaction_id);

  if (chain.find(tx => normalize(tx.transaction_id) === txId)) {
    return res.status(400).json({
      error: `Transaction ID "${transaction_id}" sudah ada di chain ${year}`
    });
  }

  // 🔥 HASH SEBELUMNYA
  const previous_hash =
    chain.length
      ? chain[chain.length - 1].current_hash
      : '0';

  // 🔥 BLOCK BARU
  const newTx = {

    transaction_id: normalize(transaction_id),
    exporter: normalize(exporter),
    importer: normalize(importer),
    port: normalize(port),
    country: normalize(country),

    volume: vol,

    created_at: normalize(created_at),
    shipped_at: normalize(shipped_at || ''),
    received_at: normalize(received_at || ''),

    status: normalize(status || 'PENDING'),

    validator: authority,

    block_timestamp: new Date().toISOString(),

    block_index: chain.length,

    previous_hash,
    current_hash: ''

  };

  // 🔥 GENERATE HASH
  newTx.current_hash = computeHash(newTx, previous_hash);

  // 🔥 MASUKKAN KE CHAIN
  chain.push(newTx);

  originalData[year].push({
    ...newTx
  });

  // 🔥 SIMPAN KE FILE JSON
  saveChainToFile(year);

  // 🔥 RESPONSE
  res.status(201).json({
    message: `Transaksi ${newTx.transaction_id} berhasil ditambahkan ke chain ${year}.`,
    block_index: chain.length - 1,
    year,
    transaction: {
      ...newTx,
      block_index: chain.length - 1,
      is_tampered: false,
      chain_link_broken: false
    }
  });
});

app.post('/upload-csv', upload.array('file', 10), async (req, res) => {

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      error: 'File tidak terbaca'
    });
  }

  let totalUploaded = 0;
  let totalDuplicates = 0;
  const uploadedFiles = [];

  for (const file of req.files) {

    const touchedYears = new Set();
    const filePath = file.path;

    // simpan file mentah ke data/raw

    const rawDir = path.join(__dirname, 'data', 'raw');

    if (!fs.existsSync(rawDir)) {
      fs.mkdirSync(rawDir, { recursive: true });
    }

    const rawFilePath = path.join(
      rawDir,
      `${Date.now()}_${file.originalname}`
    );

    fs.copyFileSync(filePath, rawFilePath);

    const results = [];

    await new Promise((resolve, reject) => {

      fs.createReadStream(filePath)
        .pipe(csv())

        .on('data', (row) => {

          const txid =
            row.transaction_id ||
            row['\uFEFFtransaction_id'];

          if (!txid) return;

          const vol = Number(row.volume);

          if (isNaN(vol)) return;

          results.push({
            transaction_id: normalize(txid),
            exporter: normalize(row.exporter),
            importer: normalize(row.importer),
            port: normalize(row.port),
            country: normalize(row.country),
            volume: vol,
            created_at: normalize(row.created_at),
            shipped_at: normalize(row.shipped_at || ''),
            received_at: normalize(row.received_at || ''),
            status: normalize(row.status || 'PENDING'),
            validator: `PORT_${normalize(row.port).replaceAll(' ', '_')}`,
            previous_hash: '',
            current_hash: ''
          });

        })

        .on('end', () => {

          results.sort((a, b) =>
            new Date(a.created_at) -
            new Date(b.created_at)
          );

          results.forEach(tx => {

            const date = new Date(tx.created_at);

            if (isNaN(date)) return;

            const year =
              date.getFullYear().toString();
            touchedYears.add(year);

            if (!workingData[year]) {
              workingData[year] = [];
              originalData[year] = [];
              tamperedBlocks[year] = new Set();
            }

            const chain = workingData[year];

            // 🔥 DUPLICATE CHECK
            const exists = chain.find(existing =>
              normalize(existing.transaction_id) ===
              normalize(tx.transaction_id)
            );

            if (exists) {
              totalDuplicates++;
              return;
            }

            const prev =
              chain.length
                ? chain[chain.length - 1].current_hash
                : '0';

            tx.previous_hash = prev;
            tx.current_hash = computeHash(tx, prev);

            chain.push(tx);
            originalData[year].push({ ...tx });

            totalUploaded++;

          });

          uploadedFiles.push(file.filename);

          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }

          touchedYears.forEach(year => {
            saveChainToFile(year);
          });

          resolve();

        })

        .on('error', reject);

    });

  }

  // 🔥 SAVE SEMUA
  Object.keys(workingData).forEach(year => {
    saveChainToFile(year);
  });

  res.json({
    message: 'Multi CSV upload berhasil',
    uploaded: totalUploaded,
    duplicates_skipped: totalDuplicates,
    files: uploadedFiles
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

loadChains();
app.listen(PORT, () => {
  console.log(`🚀 http://localhost:${PORT}`);
});
