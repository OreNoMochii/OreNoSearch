const { runIlikeSearch } = require('./packages/api/dist/repositories/postgres_repo.js');
async function test() {
  try {
    const res = await runIlikeSearch({ andGroups: [["ai engineer"]], must: [], should: [], mustNot: [], locations: [], limit: 100 });
    console.log("Success:", res.total);
  } catch (err) {
    console.error("Error:", err);
  }
}
test();
