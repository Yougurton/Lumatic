const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const archive = process.argv.includes('--archive');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const dirty = git(['status', '--porcelain']);
if (dirty) fail(`Release source is not clean. Commit or stash these changes first:\n${dirty}`);

let tag;
try {
  tag = git(['describe', '--exact-match', '--tags', 'HEAD']);
} catch {
  fail('HEAD has no exact release tag. Create the version tag before making a public release.');
}
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (tag !== `v${version}`) fail(`Release tag ${tag} does not match package.json version v${version}.`);

const head = git(['rev-parse', 'HEAD']);
const remote = git(['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
const remoteIds = remote.split(/\r?\n/u).filter(Boolean).map((line) => line.split(/\s+/u)[0]);
if (!remoteIds.includes(head)) fail(`Tag ${tag} is not published for ${head} on origin. Push the commit and tag first.`);

if (archive) {
  const output = path.join(root, 'release', `Lumatic-${version}-source.zip`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('git', ['archive', '--format=zip', `--prefix=Lumatic-${version}-source/`, '-o', output, 'HEAD'], { cwd: root, stdio: 'inherit' });
  console.log(`Source archive: ${output}`);
} else {
  console.log(`Release source verified: ${tag} at ${head} is clean and published on origin.`);
}
