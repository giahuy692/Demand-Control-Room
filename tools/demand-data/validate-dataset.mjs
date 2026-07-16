import { readFileSync, existsSync } from 'node:fs';
import { validateDataset } from './data-contract.mjs';

const targets = process.argv.length > 2 ? process.argv.slice(2) : [
  'src/assets/demand-planning/datasets/mock.dataset.json',
  'src/assets/demand-planning/datasets/real.dataset.json',
];

let failed = false;
for (const path of targets) {
  if (!existsSync(path)) {
    console.error(`✗ ${path}: KHÔNG TỒN TẠI`);
    failed = true;
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`✗ ${path}: JSON hỏng — ${error.message}`);
    failed = true;
    continue;
  }
  const errors = validateDataset(parsed);
  if (errors.length) {
    console.error(`✗ ${path}: ${errors.length} lỗi hợp đồng`);
    for (const error of errors.slice(0, 20)) console.error(`    ${error}`);
    failed = true;
  } else {
    console.log(`✓ ${path}: đạt ${parsed.contractVersion} (${parsed.datasetKind}, ${parsed.dailyRecords.length} dòng, ${parsed.products.length} SKU, runDate=${parsed.metadata.runDate})`);
  }
}
process.exit(failed ? 1 : 0);
