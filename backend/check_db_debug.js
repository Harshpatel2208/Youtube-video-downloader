const { Pool } = require('pg');
require('dotenv').config();

const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'converter_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function check() {
  try {
    console.log('Connecting to:', process.env.DB_NAME);
    const res = await db.query('SELECT id, original_name, status, error, source FROM conversions ORDER BY created_at DESC LIMIT 5');
    console.log('Records found:', res.rowCount);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error querying DB:', err.message);
  } finally {
    process.exit();
  }
}

check();
