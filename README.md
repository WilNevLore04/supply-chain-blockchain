# Supply Chain Blockchain Explorer

Sistem web untuk simulasi dan eksplorasi data supply chain berbasis blockchain.
Dataset: Ekspor CPO (Crude Palm Oil) Indonesia, 2018–2022.

---

## Cara Menjalankan

### 1. Install dependencies
```bash
cd supply-chain-blockchain
npm install
```

### 2. Jalankan server
```bash
node server.js
```

### 3. Buka browser
```
http://localhost:3000
```

---

## Struktur Folder

```
supply-chain-blockchain/
├── server.js           ← Backend Express + blockchain logic
├── package.json
├── data/               ← CSV dataset (2018–2022)
│   ├── output2018_final.csv
│   ├── output2019_final.csv
│   ├── output2020_final.csv
│   ├── output2021_final.csv
│   └── output2022_final.csv
└── public/
    └── index.html      ← Frontend web app
```

---

## API Endpoints

| Method | Endpoint              | Keterangan                                      |
|--------|-----------------------|-------------------------------------------------|
| GET    | `/transaction/:id`    | Cari transaksi by ID (contoh: TX001)            |
| GET    | `/block/:hash`        | Cari blok by current_hash                       |
| GET    | `/chain/:year`        | Tampilkan seluruh chain satu tahun (2018–2022)  |
| GET    | `/validate/:year`     | Validasi integritas chain satu tahun            |
| GET    | `/stats`              | Statistik ringkasan semua tahun                 |
| GET    | `/search?q=...`       | Cari by exporter/importer/country               |

### Contoh penggunaan API
```
GET /transaction/TX001
GET /chain/2020
GET /validate/2019
GET /search?q=cargill&year=2022
```

---

## Fitur

- **Dashboard** — statistik total transaksi, volume, status chain per tahun
- **View Transaction** — cari detail transaksi (exporter, importer, volume, hash) by ID
- **Chain Explorer** — tampilkan seluruh blok per tahun dengan status koneksi hash
- **Validate Chain** — verifikasi integritas data, deteksi manipulasi

---

## Cara Kerja Blockchain

Setiap transaksi di-hash menggunakan SHA-256 dengan input:
```
transaction_id + batch_id + exporter + importer + port + country + volume + created_at + previous_hash
```

Jika **satu field saja diubah**, hash-nya berubah total, dan blok berikutnya
langsung terdeteksi rusak karena `previous_hash`-nya tidak cocok lagi.
