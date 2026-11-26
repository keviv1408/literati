// The kernel closes our stdin pipe when the soak dies, even by SIGKILL, so no child outlives it.
process.stdin.on('close', () => process.exit(1)).resume();
