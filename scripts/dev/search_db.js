const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function search() {
  const tables = [
    'candidate_profiles_parsed', 'candidate_features_v2', 'candidates_upgraded', 
    'candidates_upgraded_backup', 'candidates_data_science_use', 'candidates_rl_features',
    'candidates_upgraded_time_machine', 'ml_training_features', 'candidates_data_science_use_v2', 'candidates'
  ];
  
  for (const table of tables) {
    try {
      const res = await pool.query(`SELECT * FROM ${table} LIMIT 1`);
      if (res.rows.length > 0) {
        const columns = Object.keys(res.rows[0]);
        for (const col of columns) {
          try {
            const match = await pool.query(`SELECT count(*) FROM ${table} WHERE CAST("${col}" AS TEXT) ILIKE '%ryohei-nishimura%'`);
            if (match.rows[0].count > 0) {
              console.log(`Found in table: ${table}, column: ${col}, count: ${match.rows[0].count}`);
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
  }
  pool.end();
}
search();
