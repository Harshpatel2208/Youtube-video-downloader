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

async function setup() {
  try {
    console.log("Checking for 'pgcrypto' extension...");
    await db.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    console.log("Creating 'conversions' table if it doesn't exist...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS conversions (
        id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        original_name VARCHAR(255) NOT NULL,
        status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
        source        VARCHAR(20)  NOT NULL DEFAULT 'local',
        source_url    TEXT,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        download_url  TEXT,
        error         TEXT
      )
    `);

    // Ensure all columns exist (in case table was created previously)
    const columns = [
      { name: 'source', type: "VARCHAR(20) DEFAULT 'local'" },
      { name: 'source_url', type: 'TEXT' },
      { name: 'download_url', type: 'TEXT' },
      { name: 'error', type: 'TEXT' }
    ];

    for (const col of columns) {
      console.log(`Ensuring column '${col.name}' exists...`);
      await db.query(`ALTER TABLE conversions ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
    }

    console.log("Database setup complete!");
  } catch (err) {
    console.error("Database setup failed:", err.message);
  } finally {
    process.exit(0);
  }
}

setup();
