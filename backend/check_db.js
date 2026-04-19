const { Pool } = require('pg');
require('dotenv').config();
const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'converter_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});
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
