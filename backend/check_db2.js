const fs = require('fs');
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
    const counts = {};
    res.rows.forEach(r => counts[r.status] = (counts[r.status]||0)+1);
    const text = `Total: ${res.rowCount}\nStatuses: ${JSON.stringify(counts)}\n\n` + 
                 res.rows.map(r => `${r.status.padEnd(10)} | ${r.original_name}`).join('\n');
    fs.writeFileSync('db_dump.txt', text);
    process.exit(0);
  });
