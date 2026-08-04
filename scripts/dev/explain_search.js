const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
});

async function run() {
  const client = await pool.connect();
  try {
    const tsquery = "(AI | engineer) & (inference | optimization | quantization | 'model' <-> 'compression' | triton | ONNX) & (cpp_lang) & !(CTO | founder | CEO)";
    
    console.log("Running EXPLAIN ANALYZE...");
    
    const res = await client.query(`
      EXPLAIN ANALYZE SELECT profile_url, name, current_company, latest_role, summary, experience 
      FROM candidates_upgraded 
      WHERE to_tsvector('english', 
          regexp_replace(
            coalesce(name, '') || ' ' || 
            coalesce(headline, '') || ' ' || 
            coalesce(latest_role, '') || ' ' || 
            coalesce(current_company, '') || ' ' || 
            coalesce(experience, '') || ' ' || 
            coalesce(summary, ''),
            'c\\+\\+', 'cpp_lang', 'ig'
          )
        ) @@ to_tsquery('english', $1)
      LIMIT 25;
    `, [tsquery]);

    for (const row of res.rows) {
      console.log(row['QUERY PLAN']);
    }

  } catch (err) {
    console.error("Failed:", err);
  } finally {
    client.release();
    pool.end();
  }
}

run();
