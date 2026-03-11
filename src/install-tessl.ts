export async function installTessl(): Promise<void> {
  const which = Bun.spawnSync(['which', 'tessl']);
  if (which.exitCode === 0) {
    console.log('tessl CLI already installed');
    return;
  }

  console.log('Installing tessl CLI...');
  const proc = Bun.spawn(
    ['sh', '-c', 'curl -fsSL https://get.tessl.io | sh'],
    {
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to install tessl CLI (exit code ${exitCode})`);
  }

  console.log('tessl CLI installed successfully');
}
