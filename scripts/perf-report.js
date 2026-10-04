// Read-only performance report: database round trip, server time per answer by
// intent, slowest queries, table reads. SELECTs only; prints no secrets.
// Run on the server from the app folder:  node scripts/perf-report.js
process.loadEnvFile('.env');
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });

const pct = (col) => `round(percentile_cont(0.5) within group (order by ${col}))::int as p50,
  round(percentile_cont(0.9) within group (order by ${col}))::int as p90,
  round(percentile_cont(0.95) within group (order by ${col}))::int as p95,
  round(percentile_cont(0.99) within group (order by ${col}))::int as p99,
  round(max(${col}))::int as max`;

async function main() {
  // 1. Database round trip from this server.
  const rt = [];
  for (let i = 0; i < 20; i++) { const t = process.hrtime.bigint(); await sql`select 1`; rt.push(Number(process.hrtime.bigint() - t) / 1e6); }
  rt.sort((a, b) => a - b);
  console.log(`\n== DB round trip (20 x select 1): p50 ${rt[9].toFixed(1)} ms, p95 ${rt[18].toFixed(1)} ms, max ${rt[19].toFixed(1)} ms`);

  // 2. End-to-end server time per answer: question saved -> answer saved, last 14 days.
  const e2e = await sql.unsafe(`
    with a as (
      select coalesce(m.intent::text, '(none)') as intent, m.latency_ms,
             extract(epoch from m.created_at - (select max(u.created_at) from chat_messages u
               where u.thread_id = m.thread_id and u.role = 'user' and u.created_at <= m.created_at)) * 1000 as ms
        from chat_messages m
       where m.role = 'assistant' and m.created_at > now() - interval '14 days')
    select intent, count(*)::int as n, ${pct('ms')}, round(avg(latency_ms))::int as stored_latency_avg
      from a where ms is not null group by 1 order by n desc`);
  console.log('\n== Server time per answer, question saved -> answer saved (ms), last 14 days');
  console.table(e2e);

  const users = await sql`select count(distinct user_id)::int as users, count(*)::int as answers
    from chat_messages where role = 'assistant' and created_at > now() - interval '14 days'`;
  console.log('Answers by', users[0].users, 'accounts:', users[0].answers);

  // 3. Slowest queries by total time (Postgres's own statistics).
  for (const table of ['extensions.pg_stat_statements', 'pg_stat_statements']) {
    try {
      const top = await sql.unsafe(`select calls, round(mean_exec_time::numeric, 1) as mean_ms, round(max_exec_time::numeric, 1) as max_ms,
          round(total_exec_time::numeric) as total_ms, rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 110) as query
        from ${table} where query not ilike '%pg_stat_statements%'
        order by total_exec_time desc limit 15`);
      console.log(`\n== Slowest queries by total time (${table})`);
      console.table(top);
      break;
    } catch (err) {
      console.log(`(${table}: ${err.message})`);
    }
  }

  // 4. Tables: size, rows, and how they are read.
  const tables = await sql`
    select relname as table, n_live_tup::int as rows, seq_scan::int, idx_scan::int,
           pg_size_pretty(pg_total_relation_size(relid)) as size
      from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 15`;
  console.log('\n== Largest tables (seq_scan = whole-table reads)');
  console.table(tables);
}

main().catch((err) => { console.error('Report failed:', err.message); process.exitCode = 1; }).finally(() => sql.end());
