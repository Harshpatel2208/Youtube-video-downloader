const { Pool } = require('pg');
require('dotenv').config();

const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'converter_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function migrate() {
  try {
    console.log("Adding 'source' and 'source_url' columns...");
    await db.query("ALTER TABLE conversions ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'local'");
    await db.query("ALTER TABLE conversions ADD COLUMN IF NOT EXISTS source_url TEXT");
    console.log("Migration successful! Your database now supports YouTube analytics.");
  } catch (err) {
    console.error("Migration failed:", err.message);
  } finally {
    process.exit(0);
  }
}

migrate();
