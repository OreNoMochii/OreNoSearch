import pool, { initDb } from './database';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    await initDb();
    
    // Fetch recent candidates
    const res = await pool.query(`SELECT profile_url, experience FROM candidates_upgraded WHERE scraped_at > NOW() - INTERVAL '4 hours'`);
    const candidates = res.rows;

    console.log(`Analyzing ${candidates.length} candidates for duplicated blocks...`);

    // Map of sequence -> Set of candidate profile_urls
    const sequenceCounts = new Map<string, Set<string>>();

    for (const c of candidates) {
        if (!c.experience) continue;
        const lines = c.experience.split('\n');
        // We only care about blocks of 3 or more lines
        for (let len = 3; len <= lines.length; len++) {
            for (let i = 0; i <= lines.length - len; i++) {
                const seq = lines.slice(i, i + len).join('\n');
                if (!sequenceCounts.has(seq)) {
                    sequenceCounts.set(seq, new Set());
                }
                sequenceCounts.get(seq)!.add(c.profile_url);
            }
        }
    }

    // Filter sequences that appear in >= 3 candidates
    // Sort by string length descending so we get maximal blocks first
    const candidatesForRemoval = Array.from(sequenceCounts.entries())
        .filter(([seq, ids]) => ids.size >= 3)
        .sort((a, b) => b[0].length - a[0].length);

    const blocksToRemove: string[] = [];
    
    for (const [seq, ids] of candidatesForRemoval) {
        // Check if this sequence is a sub-sequence of an already selected block
        let isSub = false;
        for (const block of blocksToRemove) {
            if (block.includes(seq)) {
                isSub = true;
                break;
            }
        }
        if (!isSub) {
            blocksToRemove.push(seq);
            console.log(`\n=========================================`);
            console.log(`Found corrupted block (appears in ${ids.size} profiles):`);
            console.log(`=========================================`);
            console.log(seq);
        }
    }

    console.log(`\nIdentified ${blocksToRemove.length} unique corrupted blocks. Removing them from the database...`);

    for (const block of blocksToRemove) {
        // Strip the block. We also replace \n to avoid double newlines left behind.
        await pool.query(`
            UPDATE candidates_upgraded 
            SET experience = REPLACE(experience, $1 || e'\n', '')
            WHERE scraped_at > NOW() - INTERVAL '4 hours' AND experience LIKE '%' || $1 || '%'
        `, [block]);
        
        await pool.query(`
            UPDATE candidates_upgraded 
            SET experience = REPLACE(experience, $1, '')
            WHERE scraped_at > NOW() - INTERVAL '4 hours' AND experience LIKE '%' || $1 || '%'
        `, [block]);
    }
    
    // Also remove any stray "XX yrs YY mos" at the very top of the text that might be left isolated if their real job doesn't have it
    // Wait, let's just let the SQL regex handle it when resetting roles.

    console.log("\nCleanup script complete!");
    process.exit(0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
