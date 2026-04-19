const { Pool } = require('pg');
require('dotenv').config();
const usingConnectionString = Boolean(process.env.DATABASE_URL);
const shouldUseSsl =
  process.env.DB_SSL === 'true' ||
  /sslmode=require/i.test(process.env.DATABASE_URL || '') ||
  /neon\.tech/i.test(process.env.DB_HOST || '') ||
  /neon\.tech/i.test(process.env.DATABASE_URL || '');

const dbConfig = usingConnectionString
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'converter_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
    };

if (shouldUseSsl) {
  dbConfig.ssl = { rejectUnauthorized: false };
}

const db = new Pool(dbConfig);
db.query("SELECT id, original_name, status, created_at FROM conversions ORDER BY created_at DESC LIMIT 50")
  .then(res => {
    console.log(`Found ${res.rowCount} records`);
    const counts = {};
    res.rows.forEach(r => counts[r.status] = (counts[r.status]||0)+1);
    console.log('Statuses:', counts);
    console.log('First 10 records:', res.rows.slice(0, 10));
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
