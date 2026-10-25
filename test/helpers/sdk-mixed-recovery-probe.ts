/** Recover a damaged multi-item tracker twice in a real fresh process. */
import { captureSlackOutbox, SlackOutbox } from "../../index.ts";

const box = new SlackOutbox(process.argv[2]!);
try {
  const first = await captureSlackOutbox(process.argv[2]!, box);
  const second = await captureSlackOutbox(process.argv[2]!, box);
  process.stdout.write(JSON.stringify({ first, second, rows: box.status(100).rows }));
} finally { box.close(); }
