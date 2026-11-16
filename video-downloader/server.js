#!/usr/bin/env node
import { loadConfig } from './src/config.js';
import { createApp } from './src/httpApp.js';

let config;
let app;
try {
  config = loadConfig(process.env);
  app = createApp(config);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Whatever ends the process, detached yt-dlp process groups and temp dirs must not outlive it.
process.on('exit', () => app.closeSync());

let stopping = false;
async function shutdown(reason, exitCode) {
  if (stopping) return;
  stopping = true;
  console.log(`${reason}: 진행 중인 다운로드를 정리하고 종료합니다.`);
  const force = setTimeout(() => process.exit(exitCode || 1), 8000);
  force.unref();
  try {
    await app.close();
  } finally {
    process.exit(exitCode);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => shutdown(`${signal} 수신`, 0));
}
process.on('uncaughtException', (error) => {
  console.error('처리되지 않은 오류:', error);
  shutdown('오류로 인한 종료', 1);
});
process.on('unhandledRejection', (error) => {
  console.error('처리되지 않은 오류:', error);
  shutdown('오류로 인한 종료', 1);
});

app.server.on('error', (error) => {
  console.error(`서버를 시작하지 못했습니다: ${error.message}`);
  process.exit(1); // the 'exit' hook cleans up
});

// Directories left behind by a process that was killed outright (SIGKILL, power loss).
const staleAfterMs = (config.downloadTimeoutSeconds + config.jobTtlSeconds + 600) * 1000;
app.tempDirs.sweepStale(staleAfterMs).then((removed) => {
  if (removed > 0) console.log(`이전 실행이 남긴 임시 폴더 ${removed}개를 지웠습니다.`);
});

app.server.listen(config.port, config.host, () => {
  const { port } = app.server.address();
  console.log(`${config.siteName} 서버가 시작되었습니다: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
});
