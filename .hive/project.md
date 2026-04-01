# Hive Project Policy

## Verification

- build | npm run build | TypeScript build | both | required
- test | npm test | Unit test suite | suite | required

## Hooks

- hook | pre_merge | node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));if(!p.version)process.exit(1);console.log('pre_merge OK: v'+p.version)" | Version gate | required
- hook | post_verify | echo "post_verify: all checks passed" | Post-verify log | optional
