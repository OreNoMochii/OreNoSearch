import { runIlikeSearch } from './packages/api/src/repositories/postgres_repo';
async function test() {
  try {
    const res = await runIlikeSearch({ andGroups: [["ai engineer"]], must: [], should: [], mustNot: [], locations: [], limit: 100 });
    console.log("Success:", res.total);
  } catch (err) {
    console.error("Error:", err);
  }
  process.exit(0);
}
test();
