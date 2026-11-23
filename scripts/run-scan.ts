import { scanRepository } from '../src/scan.js';

const repoPath = process.argv[2] ?? 'fixtures/sample-repo';
const report = await scanRepository({ repoPath, sinceISO: '2023-01-01' });

console.log(`providers: ${report.detectedProviders.join(', ')}`);
console.log(
  `deps: ${report.dependencies.length}  sites: ${report.callSiteCount}  changes: ${report.changes.length}`,
);
console.log(
  `findings: ${report.summary.total} (H${report.summary.high}/M${report.summary.medium}/L${report.summary.low}) files=${report.summary.filesAffected}`,
);
for (const f of report.findings) {
  console.log(
    `[${f.severity.toUpperCase()}] ${f.ruleId}/${f.match} ${f.providerId} ${f.file ?? '(repo)'}:${f.line ?? '-'} ${f.callPath ?? ''}  <- ${f.changeId}${f.codemod ? ` codemod=${f.codemod.kind}:${f.codemod.from}->${f.codemod.to}` : ''}`,
  );
}
if (report.errors.length) console.log('errors:', report.errors);
