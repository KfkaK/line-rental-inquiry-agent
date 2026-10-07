// Claude Code のクラウド（Web）セッション開始時に依存関係を入れる SessionStart フック。
// .claude/settings.json から呼ばれる。ローカル（CLAUDE_CODE_REMOTE が無い）では何もしない。
// package-lock.json が前回の npm ci から変わっていなければ入れ直さない
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

if (process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0);

const root = path.resolve(__dirname, '..');
const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
const hash = crypto.createHash('sha256').update(lock).digest('hex');
const stamp = path.join(root, 'node_modules', '.cloud-setup-hash');

if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) {
  console.log('cloud-setup: node_modules は最新（npm ci を省略）');
  process.exit(0);
}

try {
  // stdout はセッションの文脈に入るので、npm の出力は stderr に流す
  execSync('npm ci --no-audit --no-fund', { cwd: root, stdio: ['ignore', 2, 2] });
  fs.writeFileSync(stamp, hash);
  console.log('cloud-setup: npm ci 完了');
} catch {
  console.log('cloud-setup: npm ci に失敗。手動で npm ci を実行すること');
}
