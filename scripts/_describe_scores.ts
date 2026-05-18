import { createClient } from '@clickhouse/client';
import 'dotenv/config';
(async () => {
  const ch = createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'quantlab',
  });
  const q = await ch.query({ query: `DESCRIBE TABLE quantlab.strategy_scores`, format: 'JSONEachRow' });
  const cols = (await q.json()) as Array<{ name: string; type: string }>;
  for (const c of cols) console.log(c.name + ': ' + c.type);
  process.exit(0);
})();
