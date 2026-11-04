// End-to-end demo-flow verification. Requires `node server.js` running (or start it first).
const BASE = process.env.BASE || 'http://localhost:8080';
const H = (role, user) => ({ 'Content-Type': 'application/json', 'x-role': role, 'x-user': user, 'x-workspace': 'ws_acme_cloud' });

async function req(method, path, headers, body) {
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; } catch { return { status: r.status, data: text }; }
}
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
(async () => {
  const A = H('admin', 'Alex (Admin)');
  check('health', (await req('GET', '/health', A)).status === 200);
  const subs = await req('GET', '/api/submissions', A);
  check('demo draft exists', subs.data.submissions?.some((s) => s.id === 'sub_demo_flawed'));
  const pre = await req('POST', '/api/submissions/sub_demo_flawed/preflight', A, {});
  check('preflight runs', pre.status === 200 && Array.isArray(pre.data.findings), pre.data.error || '');
  const cats = (pre.data.findings || []).map((f) => f.category + ':' + f.subject);
  console.log('  findings:', JSON.stringify(cats, null, 1));
  check('finding: product name POLICY VIOLATION', cats.some((c) => c.includes('Product name terminology') && c.includes('POLICY_VIOLATION')));
  check('finding: launch CONTRADICTED', cats.some((c) => c.includes('Launch status') && c.includes('CONTRADICTED')));
  check('finding: price CONTRADICTED', cats.some((c) => c.includes('Price') && c.includes('CONTRADICTED')));
  check('finding: superlative UNSUPPORTED 50k+superlative', (pre.data.findings || []).filter((f) => f.category === 'UNSUPPORTED').length >= 2);
  check('finding: prohibited phrase POLICY VIOLATION', cats.some((c) => c.includes('Prohibited phrase') && c.includes('POLICY_VIOLATION')));
  check('finding: disclaimer missing POLICY VIOLATION', cats.some((c) => c.includes('Required disclaimer')));
  check('all evidence IDs exist in DB', (pre.data.findings || []).every((f) => f.evidence_id === '' || f.evidence_id));
  check('AI unavailable label (no key)', pre.data.ai_available === false);

  const F = await req('GET', '/api/submissions/sub_demo_flawed/findings', A);
  check('findings persist', F.data.findings?.length > 0);
  check('highlighted HTML present', typeof F.data.highlighted === 'string' && F.data.highlighted.includes('<mark'));

  const det = await req('GET', '/api/submissions/sub_demo_flawed', A);
  check('invalid transition blocked', (await req('POST', '/api/submissions/sub_demo_flawed/transition', A, { to: 'approved' })).status === 400);
  check('creator cannot approve', (await req('POST', '/api/submissions/sub_demo_flawed/transition', H('creator', 'Casey (Creator)'), { to: 'approved' })).status === 400);
  const t1 = await req('POST', '/api/submissions/sub_demo_flawed/transition', H('creator', 'Casey (Creator)'), { to: 'in_review' });
  check('submit for review', t1.data.status === 'in_review');
  const cr = await req('POST', '/api/submissions/sub_demo_flawed/transition', H('reviewer', 'Robin (Reviewer)'), { to: 'changes_requested', decision: 'Fix the flagged items' });
  check('request changes', cr.data.status === 'changes_requested');
  const rs = await req('POST', '/api/submissions/sub_demo_flawed/transition', H('creator', 'Casey (Creator)'), { to: 'resubmitted' });
  check('resubmit', rs.data.status === 'resubmitted');
  const ap = await req('POST', '/api/submissions/sub_demo_flawed/transition', H('reviewer', 'Robin (Reviewer)'), { to: 'approved', decision: 'Approved after revisions' });
  check('approve', ap.data.status === 'approved');
  const cm = await req('POST', '/api/submissions/sub_demo_flawed/comment', H('reviewer', 'Robin (Reviewer)'), { body: 'Looks good.' });
  check('comment', cm.status === 201);
  const audit = await req('GET', '/api/audit?q=sub_demo_flawed', A);
  check('audit has workflow events', audit.data.events?.length >= 3);
  const ov = await req('GET', '/api/overview', A);
  check('overview live data', typeof ov.data.total === 'number' && ov.data.total > 0);
  const ins = await req('GET', '/api/insights', A);
  check('insights derived', Array.isArray(ins.data.mostCommon));
  // empty content rejected
  const empty = await req('POST', '/api/submissions', A, { title: 'X', body: '   ' });
  check('empty content rejected', empty.status === 400);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
