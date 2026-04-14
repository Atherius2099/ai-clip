const { spawn } = require('child_process');
const path = require('path');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

(async () => {
  try {
    const root = process.cwd();
    console.log('Installing root dependencies...');
    await run('npm', ['install'], root);

    console.log('Installing backend dependencies...');
    await run('npm', ['install'], path.join(root, 'backend'));

    console.log('Installing frontend dependencies...');
    await run('npm', ['install'], path.join(root, 'frontend'));

    console.log('Bootstrap complete.');
  } catch (e) {
    console.error('Bootstrap failed:', e.message);
    process.exit(1);
  }
})();
